import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OWNER_FILE = 'owner.json'
const HEARTBEAT_INTERVAL_MS = 5_000

interface LeaseOwner {
  pid: number
  instanceId: string
  startedAt: string
  heartbeatAt: string
}

export class InstanceLeaseError extends Error {
  constructor(message: string, readonly code: 'INSTANCE_ALREADY_RUNNING' | 'INSTANCE_LOCK_UNCERTAIN' | 'INSTANCE_LOCK_IO') {
    super(message)
  }
}

export class InstanceLease {
  private heartbeat?: ReturnType<typeof setInterval>
  private released = false
  private lost = false

  private constructor(
    private readonly lockDir: string,
    private readonly owner: LeaseOwner,
  ) {}

  static async acquire(
    dataDir: string,
    now: () => Date = () => new Date(),
    liveness: (pid: number) => boolean | undefined = processLiveness,
  ): Promise<InstanceLease> {
    await mkdir(dataDir, { recursive: true })
    const lockDir = join(dataDir, '.instance-lock')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mkdir(lockDir, { recursive: false })
        const timestamp = now().toISOString()
        const owner: LeaseOwner = { pid: process.pid, instanceId: randomUUID(), startedAt: timestamp, heartbeatAt: timestamp }
        try {
          await writeFile(join(lockDir, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        } catch (error) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
        const lease = new InstanceLease(lockDir, owner)
        lease.startHeartbeat(now)
        return lease
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') {
          if (code === 'ENOENT') continue
          throw new InstanceLeaseError('単一インスタンスロックを作成できませんでした。', 'INSTANCE_LOCK_IO')
        }
      }

      const existing = await readOwner(lockDir)
      const alive = liveness(existing.pid)
      if (alive === true) {
        throw new InstanceLeaseError('同じデータ保存先を使用するアプリがすでに実行中です。', 'INSTANCE_ALREADY_RUNNING')
      }
      if (alive === undefined) {
        throw new InstanceLeaseError('既存プロセスの生存状態を確認できないため、安全のため起動を停止しました。', 'INSTANCE_LOCK_UNCERTAIN')
      }

      const staleDir = `${lockDir}.stale-${randomUUID()}`
      try {
        await rename(lockDir, staleDir)
        await rm(staleDir, { recursive: true, force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new InstanceLeaseError('停止済みインスタンスのロックを安全に回収できませんでした。', 'INSTANCE_LOCK_IO')
        }
      }
    }
    throw new InstanceLeaseError('単一インスタンスロックを取得できませんでした。', 'INSTANCE_LOCK_IO')
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    let existing: LeaseOwner
    try {
      existing = await readOwner(this.lockDir)
    } catch {
      return
    }
    if (existing.instanceId !== this.owner.instanceId) return
    await rm(this.lockDir, { recursive: true, force: true })
  }

  async assertOwned(): Promise<void> {
    if (this.released || this.lost) {
      throw new InstanceLeaseError('単一インスタンスロックの所有権が失われています。', 'INSTANCE_LOCK_UNCERTAIN')
    }
    const existing = await readOwner(this.lockDir)
    if (existing.instanceId !== this.owner.instanceId || existing.pid !== this.owner.pid) {
      this.lost = true
      throw new InstanceLeaseError('単一インスタンスロックの所有権が一致しません。', 'INSTANCE_LOCK_UNCERTAIN')
    }
  }

  private startHeartbeat(now: () => Date): void {
    this.heartbeat = setInterval(() => {
      void this.refreshHeartbeat(now).catch(() => { this.lost = true })
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
  }

  private async refreshHeartbeat(now: () => Date): Promise<void> {
    if (this.released) return
    const existing = await readOwner(this.lockDir)
    if (existing.instanceId !== this.owner.instanceId) {
      this.lost = true
      if (this.heartbeat) clearInterval(this.heartbeat)
      return
    }
    this.owner.heartbeatAt = now().toISOString()
    const temporary = join(this.lockDir, `.owner-${this.owner.instanceId}.tmp`)
    await writeFile(temporary, `${JSON.stringify(this.owner, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 })
    await rename(temporary, join(this.lockDir, OWNER_FILE))
  }
}

async function readOwner(lockDir: string): Promise<LeaseOwner> {
  try {
    const value = JSON.parse(await readFile(join(lockDir, OWNER_FILE), 'utf8')) as Partial<LeaseOwner>
    if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || typeof value.instanceId !== 'string'
      || typeof value.startedAt !== 'string' || typeof value.heartbeatAt !== 'string') {
      throw new Error('invalid owner')
    }
    return value as LeaseOwner
  } catch {
    throw new InstanceLeaseError('既存ロックの所有者を確認できないため、安全のため起動を停止しました。', 'INSTANCE_LOCK_UNCERTAIN')
  }
}

function processLiveness(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return undefined
  }
}
