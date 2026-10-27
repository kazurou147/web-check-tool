import type { InstanceLease } from './instance-lease'
import { InstanceLease as Lease } from './instance-lease'
import { useProjectStore } from './project-store'
import { useRunStore } from './run-engine'
import { initializeUrlIdentityKey } from './url-identity'

export class RuntimeUnavailableError extends Error {}

interface RuntimeState {
  promise?: Promise<void>
  lease?: InstanceLease
  error?: Error
  ready: boolean
}

const state: RuntimeState = { ready: false }

export function initializeApplicationRuntime(): Promise<void> {
  state.promise ??= initialize()
  return state.promise
}

export async function requireApplicationRuntime(): Promise<void> {
  try {
    await initializeApplicationRuntime()
  } catch {
    throw new RuntimeUnavailableError('アプリの排他制御または起動時復旧が完了していないため、新しい検査を開始できません。')
  }
  if (!state.ready) throw new RuntimeUnavailableError('アプリの起動時復旧が完了していません。')
  try {
    await state.lease?.assertOwned()
  } catch {
    state.ready = false
    throw new RuntimeUnavailableError('単一インスタンスロックの所有権を確認できないため、新しい検査を開始できません。')
  }
}

export async function releaseApplicationRuntime(): Promise<void> {
  state.ready = false
  await state.lease?.release()
  state.lease = undefined
  state.promise = undefined
  state.error = undefined
}

export function runtimeFailure(): Error | undefined {
  return state.error
}

async function initialize(): Promise<void> {
  try {
    const projectStore = useProjectStore()
    state.lease = await Lease.acquire(projectStore.dataDir)
    await initializeUrlIdentityKey(projectStore.dataDir, process.env.APP_ENCRYPTION_KEY)
    await useRunStore().recoverInterruptedRuns()
    state.ready = true
  } catch (error) {
    state.error = error instanceof Error ? error : new Error('アプリの初期化に失敗しました。')
    await state.lease?.release().catch(() => undefined)
    state.lease = undefined
    throw state.error
  }
}
