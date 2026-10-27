import ExcelJS from 'exceljs'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { H3Event } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import { LinkRequestLimiter } from '~/server/services/egress-http-client'
import { assertRunResultSize, RunStore } from '~/server/services/run-store'
import { validateXlsxArchive } from '~/server/services/xlsx-security'
import { SECURITY_ERROR_CODES, SECURITY_LIMITS } from '~/shared/security/security-constants'
import { readLimitedMultipartFormData } from '~/server/services/request-body-limits'
import { assertExcelReportRowLimit } from '~/server/services/excel-report'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Security-E リンク通信制御', () => {
  it('run全体8件・同一origin4件を超えて同時実行しない', async () => {
    const limiter = new LinkRequestLimiter(8, 4)
    let active = 0
    let maxActive = 0
    const byOrigin = new Map<string, number>()
    const maxByOrigin = new Map<string, number>()
    const order: number[] = []
    const tasks = Array.from({ length: 24 }, (_, index) => run(index, index % 3 === 0 ? 'https://b.example' : 'https://a.example'))

    await Promise.all(tasks)
    expect(maxActive).toBe(8)
    expect(maxByOrigin.get('https://a.example')).toBe(4)
    expect(maxByOrigin.get('https://b.example')).toBeLessThanOrEqual(4)
    expect(order).toEqual(Array.from({ length: 24 }, (_, index) => index))

    async function run(index: number, origin: string): Promise<void> {
      const release = await limiter.acquire(origin)
      active += 1
      maxActive = Math.max(maxActive, active)
      const originActive = (byOrigin.get(origin) ?? 0) + 1
      byOrigin.set(origin, originActive)
      maxByOrigin.set(origin, Math.max(maxByOrigin.get(origin) ?? 0, originActive))
      try {
        await new Promise(resolve => setTimeout(resolve, 5 + (index % 3)))
        order[index] = index
      } finally {
        active -= 1
        byOrigin.set(origin, originActive - 1)
        release()
      }
    }
  })

  it('キュー待機中のキャンセル後に通信枠を与えず、解放後は次を開始できる', async () => {
    const limiter = new LinkRequestLimiter(1, 1)
    const firstRelease = await limiter.acquire('https://example.com')
    const controller = new AbortController()
    const canceled = limiter.acquire('https://example.com', controller.signal)
    controller.abort()
    await expect(canceled).rejects.toBeDefined()
    firstRelease()
    const release = await limiter.acquire('https://example.com')
    release()
  })
})

describe('Security-F 大容量データ制御', () => {
  it('通常のxlsxを許可し、ZIP圧縮率が100倍を超えるエントリを拒否する', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('納品前のチェック').addRow(['ページ名', 'URL', 'title', 'description'])
    workbook.addWorksheet('Googleタグ').addRow(['タグ名', '設置コード'])
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
    expect(() => validateXlsxArchive(bytes)).not.toThrow()

    const unsafe = Buffer.from(bytes)
    const central = unsafe.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(central).toBeGreaterThanOrEqual(0)
    const compressed = unsafe.readUInt32LE(central + 20)
    unsafe.writeUInt32LE(Math.max(101, compressed * 101), central + 24)
    expect(() => validateXlsxArchive(unsafe)).toThrowError(expect.objectContaining({
      code: SECURITY_ERROR_CODES.excelArchiveUnsafe,
    }))
  })

  it('result.jsonの判定をUTF-8バイト数で行い、通常予算と保存上限を区別する', () => {
    const japaneseAndEmoji = '犬😀'
    expect(Buffer.byteLength(japaneseAndEmoji, 'utf8')).toBe(7)
    expect(() => assertRunResultSize(japaneseAndEmoji, 'checking', { operational: 6, hard: 20 })).toThrowError(expect.objectContaining({
      code: SECURITY_ERROR_CODES.resultTooLarge,
    }))
    expect(() => assertRunResultSize(japaneseAndEmoji, 'failed', { operational: 7, hard: 7 })).not.toThrow()
    expect(() => assertRunResultSize(japaneseAndEmoji, 'failed', { operational: 6, hard: 6 })).toThrowError(expect.objectContaining({
      code: SECURITY_ERROR_CODES.resultTooLarge,
    }))
  })

  it('chunked multipartを要求全体の安全上限で読み取り途中に拒否する', async () => {
    const boundary = 'security-f-boundary'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 80; index += 1) controller.enqueue(new Uint8Array(1024))
        controller.close()
      },
    })
    const event = {
      method: 'POST',
      _requestBody: stream,
      node: { req: { headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' } } },
    } as unknown as H3Event
    await expect(readLimitedMultipartFormData(event, 1024)).rejects.toMatchObject({
      code: SECURITY_ERROR_CODES.requestTooLarge,
    })
  })

  it('events.jsonl上限到達時に追記を拒否し、既存ログを変更しない', async () => {
    const dataDir = await mkdtemp(join(process.cwd(), '.test-data-security-f-'))
    temporaryDirectories.push(dataDir)
    const projectsDir = join(dataDir, 'projects')
    const projectId = randomUUID()
    const runId = randomUUID()
    const runDir = join(projectsDir, projectId, 'runs', runId)
    await mkdir(runDir, { recursive: true })
    const eventsPath = join(runDir, 'events.jsonl')
    await writeFile(eventsPath, '')
    await truncate(eventsPath, SECURITY_LIMITS.runEventsBytes)
    const store = new RunStore(projectsDir)

    await expect(store.appendEvent(projectId, runId, { type: 'must_not_append' })).rejects.toMatchObject({
      code: SECURITY_ERROR_CODES.eventLogTooLarge,
    })
    const { size } = await import('node:fs/promises').then(module => module.stat(eventsPath))
    expect(size).toBe(SECURITY_LIMITS.runEventsBytes)
  })

  it('Excelレポートの行数上限を境界値で適用する', () => {
    expect(() => assertExcelReportRowLimit(100_000)).not.toThrow()
    expect(() => assertExcelReportRowLimit(100_001)).toThrowError(expect.objectContaining({
      code: SECURITY_ERROR_CODES.reportTooLarge,
    }))
  })

  it('確定したページ・詳細・候補・アップロード上限を共有定数で保持する', () => {
    expect(SECURITY_LIMITS).toMatchObject({
      excelUploadBytes: 20 * 1024 * 1024,
      excelExpandedBytes: 100 * 1024 * 1024,
      excelZipEntries: 10_000,
      excelZipCompressionRatio: 100,
      aiResultUploadBytes: 5 * 1024 * 1024,
      runEventsBytes: 10 * 1024 * 1024,
      linkCandidatesPerPage: 2_000,
      imageCandidatesPerDevice: 2_000,
      uniquePagesPerRun: 1_000,
      runDetailItems: 100_000,
    })
  })
})
