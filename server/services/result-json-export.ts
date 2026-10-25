import type { RunResult, RunResultExport } from '~/shared/types/run'
import { isActiveRun } from '~/shared/utils/run-display'
import { AI_MASKING_NOTICE, AI_MASKING_RULE_VERSION, maskSecretText, maskSensitiveUrl } from './ai-masking'
import type { RunStore } from './run-store'

export const RESULT_JSON_EXPORT_MAX_BYTES = 50 * 1024 * 1024

export class ResultExportTooLargeError extends Error {}

export async function buildResultJsonExport(
  runStore: RunStore,
  projectId: string,
  runId: string,
  now: Date = new Date(),
  maxBytes: number = RESULT_JSON_EXPORT_MAX_BYTES,
): Promise<Buffer> {
  if (await runStore.resultFileSize(projectId, runId) > maxBytes) {
    throw new ResultExportTooLargeError('検査結果JSONが50MiBを超えているためダウンロードできません')
  }
  const stored = await runStore.get(projectId, runId)
  const masking = new ExportMaskingAccumulator()
  const result = maskTree(allowlistedResult(stored), masking) as RunResult
  const exported: RunResultExport = {
    schemaVersion: 1,
    kind: 'web-check-result-export',
    exportedAt: now.toISOString(),
    snapshot: { active: isActiveRun(stored.status), savedAt: stored.updatedAt },
    masking: masking.summary(),
    result,
  }
  const bytes = Buffer.from(`${JSON.stringify(exported, null, 2)}\n`, 'utf8')
  if (bytes.byteLength > maxBytes) {
    throw new ResultExportTooLargeError('エクスポートJSONが50MiBを超えているためダウンロードできません')
  }
  return bytes
}

export function resultJsonDownloadName(runId: string): string {
  return `web-check-result-${runId}.json`
}

function allowlistedResult(value: RunResult): RunResult {
  return {
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    projectId: value.projectId,
    ...(value.rerunOfRunId ? { rerunOfRunId: value.rerunOfRunId } : {}),
    ...(value.rerun ? { rerun: value.rerun } : {}),
    status: value.status,
    createdAt: value.createdAt,
    ...(value.startedAt ? { startedAt: value.startedAt } : {}),
    ...(value.finishedAt ? { finishedAt: value.finishedAt } : {}),
    updatedAt: value.updatedAt,
    configSnapshot: value.configSnapshot,
    input: value.input,
    summary: value.summary,
    pages: value.pages,
    links: value.links,
    images: value.images,
    googleTagDetections: value.googleTagDetections,
    ...(value.ai ? { ai: value.ai } : {}),
    aiUsage: value.aiUsage,
    ...(value.termination ? { termination: value.termination } : {}),
    ...(value.fatalError ? { fatalError: value.fatalError } : {}),
  }
}

const URL_KEYS = /(?:url|href)$/i
const IDENTIFIER_KEYS = /(?:^|_)(?:runId|projectId|bundleId|itemId|inputHash|payloadHash|signature)$/i

function maskTree(value: unknown, masking: ExportMaskingAccumulator, key = ''): unknown {
  if (typeof value === 'string') {
    if (IDENTIFIER_KEYS.test(key)) return value
    return URL_KEYS.test(key) || /^https?:\/\//i.test(value)
      ? masking.url(value)
      : masking.text(value)
  }
  if (Array.isArray(value)) return value.map(item => maskTree(item, masking, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, maskTree(child, masking, childKey)]))
  }
  return value
}

class ExportMaskingAccumulator {
  private maskedCount = 0
  private readonly categories = new Set<string>()

  text(value: string): string {
    const masked = maskSecretText(value)
    this.merge(masked)
    return masked.value
  }

  url(value: string): string {
    const masked = /^https?:\/\//i.test(value) ? maskSensitiveUrl(value) : maskSecretText(value)
    this.merge(masked)
    return masked.value
  }

  summary(): RunResultExport['masking'] {
    return {
      ruleVersion: `${AI_MASKING_RULE_VERSION}-result-export.1`,
      maskedCount: this.maskedCount,
      maskedCategories: [...this.categories].sort(),
      notice: `${AI_MASKING_NOTICE} 一般的なメールアドレスと電話番号は検査根拠として維持されます。`,
    }
  }

  private merge(masked: { maskedCount: number; maskedCategories: string[] }): void {
    this.maskedCount += masked.maskedCount
    masked.maskedCategories.forEach(category => this.categories.add(category))
  }
}
