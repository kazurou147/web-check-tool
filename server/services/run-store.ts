import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InputSnapshot } from '~/shared/types/excel-input'
import type { RunResult, RunSummary } from '~/shared/types/run'
import { projectIdSchema } from './validation'

export class RunNotFoundError extends Error {}

export class RunStore {
  private readonly writeQueues = new Map<string, Promise<void>>()

  constructor(readonly projectsDir: string) {}

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
      await atomicWrite(path, serialize(result))
      return { result, value }
    })
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
      return normalizeLegacyRun(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RunNotFoundError('検査結果が見つかりません')
      throw error
    }
  }

  async list(projectId: string): Promise<RunSummary[]> {
    const directory = join(this.projectsDir, projectId, 'runs')
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const results = (await Promise.all(entries
      .filter(entry => entry.isDirectory() && projectIdSchema.safeParse(entry.name).success)
      .map(async (entry) => {
        try {
          return await this.get(projectId, entry.name)
        } catch (error) {
          // A concurrent run creation may expose its directory just before the
          // initial atomic result file is visible. The next poll will include it.
          if (error instanceof RunNotFoundError) return undefined
          throw error
        }
      }))).filter((result): result is RunResult => result !== undefined)

    return results
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(result => ({
        runId: result.runId,
        status: result.status,
        createdAt: result.createdAt,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        updatedAt: result.updatedAt,
        totalPages: result.input.uniqueUrlCount,
        completedPages: result.pages.length,
        summary: result.summary,
        fatalError: result.fatalError,
      }))
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

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
}
