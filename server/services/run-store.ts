import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InputSnapshot } from '~/shared/types/excel-input'
import type { RunResult } from '~/shared/types/run'
import { projectIdSchema } from './validation'

export class RunNotFoundError extends Error {}

export class RunStore {
  private readonly writeQueues = new Map<string, Promise<void>>()

  constructor(private readonly projectsDir: string) {}

  runDir(projectId: string, runId: string): string {
    projectIdSchema.parse(projectId)
    projectIdSchema.parse(runId)
    return join(this.projectsDir, projectId, 'runs', runId)
  }

  async create(projectId: string, runId: string, input: InputSnapshot, result: RunResult): Promise<void> {
    const directory = this.runDir(projectId, runId)
    await mkdir(directory, { recursive: false })
    await Promise.all([
      atomicWrite(join(directory, 'input-snapshot.json'), serialize(input)),
      atomicWrite(join(directory, 'result.json'), serialize(result)),
      writeFile(join(directory, 'events.jsonl'), '', { encoding: 'utf8', flag: 'wx' }),
    ])
  }

  async saveResult(projectId: string, runId: string, result: RunResult): Promise<void> {
    const path = join(this.runDir(projectId, runId), 'result.json')
    const content = serialize(result)
    const previous = this.writeQueues.get(path) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(() => atomicWrite(path, content))
    this.writeQueues.set(path, pending)
    try {
      await pending
    } finally {
      if (this.writeQueues.get(path) === pending) this.writeQueues.delete(path)
    }
  }

  async appendEvent(projectId: string, runId: string, event: Record<string, unknown>): Promise<void> {
    const path = join(this.runDir(projectId, runId), 'events.jsonl')
    await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8' })
  }

  async get(projectId: string, runId: string): Promise<RunResult> {
    try {
      const value = JSON.parse(await readFile(join(this.runDir(projectId, runId), 'result.json'), 'utf8')) as RunResult
      if (value.schemaVersion !== 1 || value.projectId !== projectId || value.runId !== runId) {
        throw new Error('検査結果の形式が不正です')
      }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunNotFoundError('検査結果が見つかりません')
      throw error
    }
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
}
