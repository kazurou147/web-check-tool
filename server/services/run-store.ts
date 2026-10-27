import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { InputSnapshot } from '~/shared/types/excel-input'
import type { RunHistoryHealth } from '~/shared/types/project'
import type { ActiveRunStatus, RunResult, RunSummary } from '~/shared/types/run'
import { activeRunStatuses } from '~/shared/utils/run-display'
import { projectIdSchema } from './validation'
import { secureEvent, secureInputSnapshot, secureRunResult } from './persistence-security'
import { initializeUrlIdentityKey } from './url-identity'
import { SECURITY_ERROR_CODES, SECURITY_LIMITS, SecurityFoundationError } from '~/shared/security/security-constants'

export class RunNotFoundError extends Error {}
export class RunReportNotFoundError extends Error {}
export class RunRecoveryError extends Error {}
export class RunCorruptError extends Error {}
export class RunTooLargeError extends Error {}
export class RunResultSizeError extends SecurityFoundationError {}
export class RunEventSizeError extends SecurityFoundationError {}
export class RunReportSizeError extends SecurityFoundationError {}

export const MAX_RUN_RESULT_BYTES = SECURITY_LIMITS.runResultHardBytes
const RUN_LIST_READ_CONCURRENCY = 4

export interface RunListResult {
  runs: RunSummary[]
  health: RunHistoryHealth
}

export interface RunRecoveryReport {
  recovered: Array<{ projectId: string; runId: string; previousStatus: ActiveRunStatus }>
  skippedInvalid: number
}

export class RunStore {
  private readonly writeQueues = new Map<string, Promise<void>>()

  constructor(readonly projectsDir: string) {}

  runDir(projectId: string, runId: string): string {
    projectIdSchema.parse(projectId)
    projectIdSchema.parse(runId)
    return join(this.projectsDir, projectId, 'runs', runId)
  }

  reportPath(projectId: string, runId: string): string {
    return join(this.runDir(projectId, runId), 'report.xlsx')
  }

  async create(projectId: string, runId: string, input: InputSnapshot, result: RunResult): Promise<void> {
    const directory = this.runDir(projectId, runId)
    const key = await this.identityKey()
    const safeInput = secureInputSnapshot(input, key)
    const safeResult = secureRunResult(result, key)
    const resultContent = serialize(safeResult)
    assertRunResultSize(resultContent, result.status)
    await mkdir(directory, { recursive: false })
    await Promise.all([
      atomicWrite(join(directory, 'input-snapshot.json'), serialize(safeInput)),
      atomicWrite(join(directory, 'result.json'), resultContent),
      writeFile(join(directory, 'events.jsonl'), '', { encoding: 'utf8', flag: 'wx' }),
    ])
  }

  async saveResult(projectId: string, runId: string, result: RunResult): Promise<void> {
    const path = join(this.runDir(projectId, runId), 'result.json')
    const content = serialize(secureRunResult(result, await this.identityKey()))
    assertRunResultSize(content, result.status)
    await this.enqueue(path, () => atomicWrite(path, content))
  }

  async updateResult<T>(
    projectId: string,
    runId: string,
    update: (result: RunResult) => T | Promise<T>,
  ): Promise<{ result: RunResult; value: T }> {
    const path = join(this.runDir(projectId, runId), 'result.json')
    return await this.enqueue(path, async () => {
      let result: RunResult
      try {
        result = normalizeLegacyRun(JSON.parse(await readFile(path, 'utf8')) as RunResult)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunNotFoundError('検査結果が見つかりません')
        throw error
      }
      if (result.schemaVersion !== 1 || result.projectId !== projectId || result.runId !== runId) {
        throw new Error('検査結果の形式が不正です')
      }
      const value = await update(result)
      const safeResult = secureRunResult(result, await this.identityKey())
      const content = serialize(safeResult)
      assertRunResultSize(content, safeResult.status)
      await atomicWrite(path, content)
      return { result: safeResult, value }
    })
  }

  async appendEvent(projectId: string, runId: string, event: Record<string, unknown>): Promise<void> {
    const path = join(this.runDir(projectId, runId), 'events.jsonl')
    const line = `${JSON.stringify(secureEvent(event, await this.identityKey()))}\n`
    await this.enqueue(path, async () => {
      const current = await stat(path).then(value => value.size).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      })
      if (current + Buffer.byteLength(line, 'utf8') > SECURITY_LIMITS.runEventsBytes) {
        throw new RunEventSizeError(SECURITY_ERROR_CODES.eventLogTooLarge, 'イベントログがサイズ上限に達しました。')
      }
      await appendFile(path, line, { encoding: 'utf8' })
    })
  }

  async saveReport(projectId: string, runId: string, bytes: Uint8Array): Promise<void> {
    await this.get(projectId, runId)
    if (bytes.byteLength > SECURITY_LIMITS.excelReportBytes) {
      throw new RunReportSizeError(SECURITY_ERROR_CODES.reportTooLarge, 'Excelレポートがサイズ上限を超えています。')
    }
    const path = this.reportPath(projectId, runId)
    await this.enqueue(path, () => atomicWriteBytes(path, bytes))
  }

  async readReport(projectId: string, runId: string): Promise<Buffer> {
    await this.get(projectId, runId)
    try {
      return await readFile(this.reportPath(projectId, runId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunReportNotFoundError('Excelレポートがまだ生成されていません')
      throw error
    }
  }

  async get(projectId: string, runId: string): Promise<RunResult> {
    const path = join(this.runDir(projectId, runId), 'result.json')
    return await this.enqueue(path, async () => {
      try {
        if ((await stat(path)).size > MAX_RUN_RESULT_BYTES) {
          throw new RunTooLargeError('検査結果が読込上限を超えています')
        }
        const value = JSON.parse(await readFile(path, 'utf8')) as RunResult
        if (value.schemaVersion !== 1 || value.projectId !== projectId || value.runId !== runId) {
          throw new RunCorruptError('検査結果の形式が不正です')
        }
        return normalizeLegacyRun(value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunNotFoundError('検査結果が見つかりません')
        if (error instanceof RunTooLargeError || error instanceof RunCorruptError) throw error
        if (error instanceof SyntaxError) throw new RunCorruptError('検査結果を読み取れません')
        throw error
      }
    })
  }

  async resultFileSize(projectId: string, runId: string): Promise<number> {
    try {
      return (await stat(join(this.runDir(projectId, runId), 'result.json'))).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunNotFoundError('検査結果が見つかりません')
      throw error
    }
  }

  async list(projectId: string): Promise<RunSummary[]> {
    return (await this.listDetailed(projectId)).runs
  }

  async listDetailed(projectId: string): Promise<RunListResult> {
    const directory = join(this.projectsDir, projectId, 'runs')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { runs: [], health: { corruptedCount: 0, oversizedCount: 0 } }
      }
      throw error
    }
    const health: RunHistoryHealth = { corruptedCount: 0, oversizedCount: 0 }
    const names = entries
      .filter(entry => entry.isDirectory() && projectIdSchema.safeParse(entry.name).success)
      .map(entry => entry.name)
    const results = (await mapWithConcurrency(names, RUN_LIST_READ_CONCURRENCY, async (runId) => {
        try {
          return await this.get(projectId, runId)
        } catch (error) {
          // A concurrent run creation may expose its directory just before the
          // initial atomic result file is visible. The next poll will include it.
          if (error instanceof RunNotFoundError) return undefined
          if (error instanceof RunCorruptError) {
            health.corruptedCount += 1
            return undefined
          }
          if (error instanceof RunTooLargeError) {
            health.oversizedCount += 1
            return undefined
          }
          throw error
        }
      })).filter((result): result is RunResult => result !== undefined)

    const runs = results
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId))
      .map(toRunSummary)
    return { runs, health }
  }

  async recoverInterruptedRuns(now: Date = new Date()): Promise<RunRecoveryReport> {
    const report: RunRecoveryReport = { recovered: [], skippedInvalid: 0 }
    let projects
    try {
      projects = await readdir(this.projectsDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report
      throw error
    }
    for (const project of projects) {
      if (!project.isDirectory() || !projectIdSchema.safeParse(project.name).success) continue
      const runsDir = join(this.projectsDir, project.name, 'runs')
      let runs
      try {
        runs = await readdir(runsDir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const run of runs) {
        if (!run.isDirectory() || !projectIdSchema.safeParse(run.name).success) continue
        try {
          const current = await this.get(project.name, run.name)
          if (!activeRunStatuses.includes(current.status)) continue
          const previousStatus = current.status as ActiveRunStatus
          const finalizedAt = now.toISOString()
          current.status = 'interrupted'
          current.finishedAt = finalizedAt
          current.updatedAt = finalizedAt
          current.termination = {
            kind: 'interrupted',
            reasonCode: 'PROCESS_RESTART',
            previousStatus,
            finalizedAt,
          }
          if (current.ai?.status === 'api_checking' || current.ai?.status === 'preparing') current.ai.status = 'interrupted'
          await this.saveResult(project.name, run.name, current)
          await this.appendEvent(project.name, run.name, {
            at: finalizedAt,
            type: 'run_interrupted',
            previousStatus,
            reasonCode: 'PROCESS_RESTART',
          }).catch(() => undefined)
          report.recovered.push({ projectId: project.name, runId: run.name, previousStatus })
        } catch (error) {
          report.skippedInvalid += 1
          if (error instanceof RunCorruptError || error instanceof RunTooLargeError) continue
          throw new RunRecoveryError(`run ${run.name} の起動時復旧に失敗しました。`, { cause: error })
        }
      }
    }
    return report
  }

  private async enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(path) ?? Promise.resolve()
    let resolveTail!: () => void
    const tail = new Promise<void>(resolve => { resolveTail = resolve })
    this.writeQueues.set(path, tail)
    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      resolveTail()
      if (this.writeQueues.get(path) === tail) this.writeQueues.delete(path)
    }
  }

  private async identityKey(): Promise<Buffer> {
    const dataDir = basename(this.projectsDir).toLowerCase() === 'projects' ? dirname(this.projectsDir) : this.projectsDir
    return await initializeUrlIdentityKey(dataDir, process.env.APP_ENCRYPTION_KEY)
  }
}

function toRunSummary(result: RunResult): RunSummary {
  return {
    runId: result.runId,
    rerunOfRunId: result.rerunOfRunId,
    status: result.status,
    createdAt: result.createdAt,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    updatedAt: result.updatedAt,
    totalPages: result.input.uniqueUrlCount,
    completedPages: result.pages.length,
    summary: result.summary,
    termination: result.termination,
    fatalError: result.fatalError,
  }
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function normalizeLegacyRun(value: RunResult): RunResult {
  const mode = value.configSnapshot.aiMode ?? 'off'
  const aiUsage = value.aiUsage ?? {
    enabled: mode !== 'off',
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    costLimitUsd: 1,
    stoppedByCostLimit: false,
  }
  return {
    ...value,
    configSnapshot: { ...value.configSnapshot, aiMode: mode },
    input: {
      ...value.input,
      pageRows: value.input.pageRows ?? [],
      invalidRows: value.input.invalidRows ?? [],
      headerIssues: value.input.headerIssues ?? [],
      formulaIssues: value.input.formulaIssues ?? [],
      mergeIssues: value.input.mergeIssues ?? [],
      tagIssues: value.input.tagIssues ?? [],
      duplicateGroups: value.input.duplicateGroups ?? [],
      expectedGoogleTags: value.input.expectedGoogleTags ?? [],
    },
    summary: { ...value.summary, excluded: value.summary.excluded ?? 0 },
    pages: value.pages ?? [],
    links: value.links ?? [],
    images: value.images ?? [],
    googleTagDetections: value.googleTagDetections ?? [],
    aiUsage: {
      ...aiUsage,
      cachedInputTokens: aiUsage.cachedInputTokens ?? 0,
      apiFailureCount: aiUsage.apiFailureCount ?? 0,
    },
    ai: value.ai ?? {
      mode,
      status: mode === 'off' ? 'disabled' : 'preparation_failed',
      contractVersion: '1.0.0',
      promptVersion: '1.0.0',
      ...(mode === 'off' ? {} : {
        error: {
          code: 'LEGACY_AI_DATA_UNAVAILABLE',
          message: 'この履歴にはAI判定用入力データが保存されていません。',
        },
      }),
    },
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function assertRunResultSize(
  content: string,
  status: RunResult['status'],
  limits: { hard: number; operational: number } = {
    hard: SECURITY_LIMITS.runResultHardBytes,
    operational: SECURITY_LIMITS.runResultOperationalBudgetBytes,
  },
): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > limits.hard) {
    throw new RunResultSizeError(SECURITY_ERROR_CODES.resultTooLarge, '検査結果が保存上限を超えています。')
  }
  if (bytes > limits.operational) {
    throw new RunResultSizeError(SECURITY_ERROR_CODES.resultTooLarge, '検査結果が通常運用予算に達したため安全に停止しました。')
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  await renameWithWindowsRetry(temporary, path)
}

async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx' })
  await renameWithWindowsRetry(temporary, path)
}

async function renameWithWindowsRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 4) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}
