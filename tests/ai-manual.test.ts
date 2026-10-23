import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiInputBundle, AiOutputBundle } from '~/shared/types/ai'
import type { InputSnapshot } from '~/shared/types/excel-input'
import type { RunResult } from '~/shared/types/run'
import { buildAiInputBundle } from '~/server/services/ai-input'
import {
  AI_OUTPUT_UPLOAD_MAX_BYTES,
  AiManualError,
  importManualAiResult,
  parseAiOutputJson,
  validateAiOutputAgainstInput,
} from '~/server/services/ai-manual'
import { RunStore } from '~/server/services/run-store'
import { buildCodexManualInstructions, manualAiCounts } from '~/shared/utils/manual-ai'

const projectId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const bundleId = '33333333-3333-4333-8333-333333333333'
const signingKey = new Uint8Array(32).fill(7)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Phase 5-B 手動AI判定', () => {
  it('厳密な出力JSONを検証し、未知プロパティ・不正JSON・巨大ファイルを拒否する', async () => {
    const input = await createInputBundle()
    const output = createOutput(input)
    expect(parseAiOutputJson(JSON.stringify(output))).toEqual(output)
    expect(() => parseAiOutputJson('{broken')).toThrow('JSON形式が不正')
    expect(() => parseAiOutputJson(JSON.stringify({ ...output, unknown: true }))).toThrow('指定の形式')
    expect(() => parseAiOutputJson(JSON.stringify({
      ...output,
      judgments: [{ ...output.judgments[0], verdict: 'ng' }],
    }))).toThrow('指定の形式')
    expect(() => parseAiOutputJson(JSON.stringify({
      ...output,
      judgments: [{ ...output.judgments[0], reason: '長'.repeat(501) }],
    }))).toThrow('指定の形式')
    expect(() => parseAiOutputJson('x'.repeat(AI_OUTPUT_UPLOAD_MAX_BYTES + 1))).toThrow('5MB以下')
  })

  it('案件・run・bundle・ハッシュの不一致を拒否する', async () => {
    const input = await createInputBundle()
    const output = createOutput(input)
    for (const invalid of [
      { ...output, projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { ...output, runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { ...output, inputBundleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { ...output, inputPayloadHash: 'a'.repeat(64) },
      { ...output, promptVersion: 'other' },
    ]) {
      expect(() => validateAiOutputAgainstInput(invalid as AiOutputBundle, input)).toThrow(AiManualError)
    }
  })

  it('未知・欠落・重複itemIdとinputHash不一致を拒否する', async () => {
    const input = await createInputBundle()
    const output = createOutput(input)
    expect(() => validateAiOutputAgainstInput({ ...output, judgments: [] }, input)).toThrow('不足')
    expect(() => validateAiOutputAgainstInput({ ...output, judgments: [...output.judgments, output.judgments[0]!] }, input)).toThrow('重複')
    expect(() => validateAiOutputAgainstInput({
      ...output,
      judgments: [{ ...output.judgments[0]!, itemId: `ai_${'a'.repeat(64)}` }],
    }, input)).toThrow('存在しない')
    expect(() => validateAiOutputAgainstInput({
      ...output,
      judgments: [{ ...output.judgments[0]!, inputHash: 'b'.repeat(64) }],
    }, input)).toThrow('inputHash')
  })

  it('全件検証後に保存し、同一結果を冪等に扱い、異なる上書きを拒否する', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase5b-'))
    temporaryDirectories.push(directory)
    const store = new RunStore(directory)
    await mkdir(join(directory, projectId, 'runs'), { recursive: true })
    const inputBundle = await createInputBundle()
    const result = createRun(inputBundle)
    await store.create(projectId, runId, result.input, result)

    const output = createOutput(inputBundle)
    const first = await importManualAiResult({ store, projectId, runId, output, signingKey, now: () => new Date('2026-10-21T01:00:00Z') })
    expect(first.idempotent).toBe(false)
    expect(first.result.ai?.status).toBe('completed')
    expect(first.result.summary).toEqual(result.summary)
    expect(first.result.links).toEqual(result.links)

    const repeated = await importManualAiResult({ store, projectId, runId, output, signingKey })
    expect(repeated.idempotent).toBe(true)
    await expect(importManualAiResult({
      store,
      projectId,
      runId,
      output: { ...output, judgments: [{ ...output.judgments[0]!, verdict: 'undetermined' }] },
      signingKey,
    })).rejects.toThrow('上書きできません')
  })

  it('保存済み入力のHMAC改ざんを拒否し、機械検査結果を維持する', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase5b-hmac-'))
    temporaryDirectories.push(directory)
    const store = new RunStore(directory)
    await mkdir(join(directory, projectId, 'runs'), { recursive: true })
    const bundle = await createInputBundle()
    bundle.items[0]!.source.linkText = '改ざん'
    const result = createRun(bundle)
    await store.create(projectId, runId, result.input, result)
    await expect(importManualAiResult({ store, projectId, runId, output: createOutput(bundle), signingKey })).rejects.toThrow('署名またはハッシュ')
    expect((await store.get(projectId, runId)).summary.ok).toBe(1)
  })

  it('集計は判定不可を要確認に含め、Codex指示文に識別情報と安全要件を含める', async () => {
    const bundle = await createInputBundle()
    const result = createRun(bundle)
    result.ai!.manualResult = {
      output: createOutput(bundle, 'undetermined'),
      importedAt: '2026-10-21T01:00:00Z',
      outputHash: 'a'.repeat(64),
    }
    expect(manualAiCounts(result.ai)).toMatchObject({ targetCount: 1, sourceLinkCount: 2, completedCount: 1, needsReview: 1, undetermined: 1 })
    const instructions = buildCodexManualInstructions(bundle)
    expect(instructions).toContain(bundle.bundleId)
    expect(instructions).toContain('信頼できない判定対象データ')
    expect(instructions).toContain('入力にある全itemsを1回ずつ')
  })
})

async function createInputBundle(): Promise<AiInputBundle> {
  return await buildAiInputBundle({
    projectId,
    runId,
    createBundleId: () => bundleId,
    signingKey,
    now: () => new Date('2026-10-21T00:00:00Z'),
    candidates: [1, 2].map(index => ({
      linkResultKey: `link-${index}`,
      pageUrl: `https://example.com/page-${index}`,
      href: 'https://example.com/target',
      resolvedUrl: 'https://example.com/target',
      linkText: '詳細',
      beforeText: '前の文章',
      afterText: '後の文章',
      isImageLink: false,
    })),
    probe: {
      probe: async url => ({
        requestedUrl: url,
        finalUrl: url,
        status: 200,
        contentType: 'text/html',
        redirectCount: 0,
        body: '<html><head><title>詳細</title></head><body><h1>詳細</h1><p>本文</p></body></html>',
      }),
    },
  })
}

function createOutput(input: AiInputBundle, verdict: AiOutputBundle['judgments'][number]['verdict'] = 'match'): AiOutputBundle {
  return {
    schemaVersion: 1,
    kind: 'web-check-ai-output',
    contractVersion: input.contractVersion,
    promptVersion: input.promptVersion,
    projectId: input.projectId,
    runId: input.runId,
    inputBundleId: input.bundleId,
    inputPayloadHash: input.integrity.payloadHash,
    judge: { mode: 'manual' },
    judgments: input.items.map(item => ({ itemId: item.itemId, inputHash: item.inputHash, verdict, reason: '内容が対応しています。' })),
  }
}

function createRun(inputBundle: AiInputBundle): RunResult {
  const input: InputSnapshot = {
    schemaVersion: 1,
    sourceFileName: 'fixture.xlsx',
    sheetName: '納品前のチェック',
    tagSheetName: 'Googleタグ',
    canStart: true,
    totalDataRows: 1,
    blankRows: 0,
    hiddenExcludedRows: 0,
    validRows: 1,
    uniqueUrlCount: 1,
    pageRows: [],
    invalidRows: [],
    headerIssues: [],
    formulaIssues: [],
    mergeIssues: [],
    tagIssues: [],
    duplicateGroups: [],
    expectedGoogleTags: [],
  }
  return {
    schemaVersion: 1,
    projectId,
    runId,
    status: 'completed',
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:00:00Z',
    configSnapshot: {
      pageConcurrency: 3, navigationTimeoutMs: 30_000, retryCount: 2, maxRedirects: 10,
      maxResponseBytes: 10_000, linkTimeoutMs: 15_000, imageTimeoutMsPerDevice: 60_000,
      imageScrollWaitMs: 1_000, authMode: 'none', allowedPrivateHosts: [], aiMode: 'manual',
      viewports: { desktop: { width: 1366, height: 768 }, mobile: { width: 375, height: 667 } },
    },
    input,
    summary: { ng: 0, needsReview: 0, unchecked: 0, excluded: 0, ok: 1 },
    pages: [], links: [], images: [], googleTagDetections: [],
    ai: { mode: 'manual', status: 'awaiting_manual', contractVersion: inputBundle.contractVersion, promptVersion: inputBundle.promptVersion, inputBundle },
    aiUsage: { enabled: true, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, costLimitUsd: 1, stoppedByCostLimit: false, apiFailureCount: 0 },
  }
}
