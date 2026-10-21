import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  AiInputBundle,
  AiLinkInput,
  AiLinkTarget,
  AiTargetHeading,
} from '~/shared/types/ai'
import type { LinkProbe } from './checks/links'
import { AiMaskingAccumulator } from './ai-masking'

export const AI_CONTRACT_VERSION = '1.0.0'
export const AI_PROMPT_VERSION = '1.1.0'
export const AI_SOURCE_CONTEXT_LIMIT = 200
export const AI_BODY_EXCERPT_LIMIT = 3_000
const AI_SIGNING_KEY_FILE = '.ai-signing-key'

export class AiSigningKeyError extends Error {
  constructor(message: string, readonly code: 'AI_SIGNING_KEY_INVALID' | 'AI_SIGNING_KEY_IO_FAILED') {
    super(message)
  }
}

export class AiInputBuildError extends Error {
  constructor(
    readonly code: 'AI_INPUT_ITEM_BUILD_FAILED' | 'AI_INPUT_SCHEMA_INVALID',
    readonly failurePoint: 'item_build' | 'schema_validation',
    readonly safeDetails: { itemSequence?: number; issuePaths?: string[]; issueCodes?: string[] },
  ) {
    super(code)
  }
}

export interface AiSourceCandidate {
  linkResultKey: string
  pageUrl: string
  href: string
  resolvedUrl: string
  linkText: string
  beforeText: string
  afterText: string
  isImageLink: boolean
}

export interface BuildAiInputBundleOptions {
  projectId: string
  runId: string
  candidates: AiSourceCandidate[]
  probe: LinkProbe
  signingKey: Uint8Array
  now?: () => Date
  createBundleId?: () => string
}

const codePointString = (limit: number) => z.string().refine(
  value => Array.from(value).length <= limit,
  { message: `${limit}文字以内で指定してください` },
)

const headingSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  text: z.string().max(10_000),
}).strict()

const sourceReferenceSchema = z.object({
  linkResultKey: z.string().min(1).max(8_192),
  pageUrl: z.string().min(1).max(4_096),
}).strict()

const maskingSchema = z.object({
  ruleVersion: z.string().min(1).max(100),
  maskedCount: z.number().int().min(0),
  maskedCategories: z.array(z.string().min(1).max(100)).max(100),
  notice: z.string().min(1).max(2_000),
}).strict()

const aiLinkInputSchema = z.object({
  sequence: z.number().int().min(0),
  itemId: z.string().regex(/^ai_[0-9a-f]{64}$/),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.object({
    pageUrl: z.string().min(1).max(4_096),
    linkText: z.string().max(10_000),
    beforeText: codePointString(AI_SOURCE_CONTEXT_LIMIT),
    afterText: codePointString(AI_SOURCE_CONTEXT_LIMIT),
  }).strict(),
  sourceReferences: z.array(sourceReferenceSchema).min(1).max(100_000),
  target: z.object({
    normalizedUrl: z.string().min(1).max(4_096),
    finalUrl: z.string().max(4_096).optional(),
    title: z.string().max(10_000).optional(),
    headings: z.array(headingSchema).max(10_000),
    bodyExcerpt: codePointString(AI_BODY_EXCERPT_LIMIT),
    fetchStatus: z.enum(['available', 'unsupported_protocol', 'pdf', 'http_error', 'non_html', 'fetch_failed']),
    unavailableReason: z.string().max(2_000).optional(),
  }).strict(),
  masking: maskingSchema,
}).strict()

export const aiInputBundleSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('web-check-ai-input'),
  contractVersion: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(100),
  bundleId: z.uuid(),
  projectId: z.uuid(),
  runId: z.uuid(),
  generatedAt: z.iso.datetime(),
  contentTreatment: z.literal('untrusted_data'),
  items: z.array(aiLinkInputSchema).max(100_000),
  integrity: z.object({
    algorithm: z.literal('HMAC-SHA256'),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict()

export async function buildAiInputBundle(options: BuildAiInputBundleOptions): Promise<AiInputBundle> {
  const grouped = groupCandidates(options.candidates)
  const targetCache = new Map<string, Promise<RawTarget>>()
  const items: AiLinkInput[] = []

  for (const group of grouped) {
    try {
      const primary = group.candidates[0]!
      const rawTarget = await getTarget(primary.resolvedUrl, options.probe, targetCache)
      const masking = new AiMaskingAccumulator()
      const source = {
        pageUrl: maskAndLimit(masking, 'url', primary.pageUrl, 4_096, 'start'),
        linkText: maskAndLimit(masking, 'text', primary.linkText, 10_000, 'start'),
        beforeText: maskAndLimit(masking, 'text', primary.beforeText, AI_SOURCE_CONTEXT_LIMIT, 'end'),
        afterText: maskAndLimit(masking, 'text', primary.afterText, AI_SOURCE_CONTEXT_LIMIT, 'start'),
      }
      const sourceReferences = group.candidates.map(candidate => ({
        linkResultKey: maskAndLimit(masking, 'text', candidate.linkResultKey, 8_192, 'start'),
        pageUrl: maskAndLimit(masking, 'url', candidate.pageUrl, 4_096, 'start'),
      }))
      const target = maskTarget(rawTarget, masking)
      const itemId = `ai_${sha256(`ai-item-v1\n${group.dedupeKey}`)}`
      const inputHash = sha256(stableStringify({ source, sourceReferences, target }))
      items.push({
        sequence: items.length,
        itemId,
        inputHash,
        source,
        sourceReferences,
        target,
        masking: masking.summary(),
      })
    } catch {
      throw new AiInputBuildError('AI_INPUT_ITEM_BUILD_FAILED', 'item_build', { itemSequence: items.length })
    }
  }

  const unsigned = {
    schemaVersion: 1 as const,
    kind: 'web-check-ai-input' as const,
    contractVersion: AI_CONTRACT_VERSION,
    promptVersion: AI_PROMPT_VERSION,
    bundleId: (options.createBundleId ?? randomUUID)(),
    projectId: options.projectId,
    runId: options.runId,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    contentTreatment: 'untrusted_data' as const,
    items,
  }
  const payload = stableStringify(unsigned)
  const payloadHash = sha256(payload)
  const bundle: AiInputBundle = {
    ...unsigned,
    integrity: {
      algorithm: 'HMAC-SHA256',
      payloadHash,
      signature: hmac(payload, options.signingKey),
    },
  }
  const parsed = aiInputBundleSchema.safeParse(bundle)
  if (!parsed.success) {
    throw new AiInputBuildError('AI_INPUT_SCHEMA_INVALID', 'schema_validation', {
      issuePaths: [...new Set(parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean))].slice(0, 20),
      issueCodes: [...new Set(parsed.error.issues.map(issue => issue.code))].slice(0, 20),
    })
  }
  return parsed.data
}

export function verifyAiInputBundle(value: unknown, signingKey: Uint8Array): AiInputBundle {
  const bundle = aiInputBundleSchema.parse(value)
  const { integrity, ...unsigned } = bundle
  const payload = stableStringify(unsigned)
  const actualHash = sha256(payload)
  if (!safeEqualHex(actualHash, integrity.payloadHash)) throw new Error('AI入力データのハッシュが一致しません')
  const actualSignature = hmac(payload, signingKey)
  if (!safeEqualHex(actualSignature, integrity.signature)) throw new Error('AI入力データの署名が一致しません')
  return bundle
}

export function deriveAiSigningKey(masterKey: string | undefined): Buffer {
  if (!masterKey) throw new Error('AI入力署名用の暗号鍵が設定されていません')
  const decoded = /^[0-9a-f]{64}$/i.test(masterKey)
    ? Buffer.from(masterKey, 'hex')
    : Buffer.from(masterKey, 'base64')
  if (decoded.byteLength !== 32) throw new Error('AI入力署名用の暗号鍵は32バイトで指定してください')
  return createHmac('sha256', decoded).update('website-delivery-checker:ai-input-signing:v1').digest()
}

export async function loadOrCreateAiSigningKey(projectsDir: string, masterKey?: string): Promise<Buffer> {
  const keyPath = join(dirname(projectsDir), AI_SIGNING_KEY_FILE)
  try {
    return decodeStoredSigningKey(await readFile(keyPath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof AiSigningKeyError) throw error
      throw new AiSigningKeyError('AI署名鍵を読み込めませんでした。', 'AI_SIGNING_KEY_IO_FAILED')
    }
  }

  let key: Buffer
  try {
    key = masterKey ? deriveAiSigningKey(masterKey) : randomBytes(32)
  } catch {
    throw new AiSigningKeyError('AI署名鍵の設定が不正です。', 'AI_SIGNING_KEY_INVALID')
  }

  try {
    await mkdir(dirname(keyPath), { recursive: true })
    await writeFile(keyPath, `${key.toString('base64')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        return decodeStoredSigningKey(await readFile(keyPath, 'utf8'))
      } catch {
        throw new AiSigningKeyError('AI署名鍵を読み込めませんでした。', 'AI_SIGNING_KEY_IO_FAILED')
      }
    }
    throw new AiSigningKeyError('AI署名鍵を保存できませんでした。', 'AI_SIGNING_KEY_IO_FAILED')
  }
}

function decodeStoredSigningKey(value: string): Buffer {
  try {
    const decoded = Buffer.from(value.trim(), 'base64')
    if (decoded.byteLength !== 32) throw new Error('invalid length')
    return decoded
  } catch {
    throw new AiSigningKeyError('保存済みAI署名鍵の形式が不正です。', 'AI_SIGNING_KEY_INVALID')
  }
}

export function extractAiTargetContent(html: string): Pick<AiLinkTarget, 'title' | 'headings' | 'bodyExcerpt'> {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html)
  const contentHtml = removeNonContent(html)
  const headings: AiTargetHeading[] = []
  const headingPattern = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1\s*>/giu
  for (const match of contentHtml.matchAll(headingPattern)) {
    headings.push({ level: Number(match[1]) as 1 | 2 | 3, text: htmlFragmentToText(match[2] ?? '') })
  }
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/iu.exec(contentHtml)
  const body = bodyMatch?.[1] ?? contentHtml
  const bodyExcerpt = limitCodePoints(htmlFragmentToText(body), AI_BODY_EXCERPT_LIMIT, 'start')
  const title = titleMatch ? htmlFragmentToText(titleMatch[1] ?? '') : undefined
  return { title: title || undefined, headings, bodyExcerpt }
}

export function limitCodePoints(value: string, limit: number, side: 'start' | 'end'): string {
  const characters = Array.from(value)
  return side === 'start' ? characters.slice(0, limit).join('') : characters.slice(-limit).join('')
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

interface CandidateGroup {
  dedupeKey: string
  candidates: AiSourceCandidate[]
}

function groupCandidates(candidates: AiSourceCandidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>()
  const sorted = [...candidates].sort((left, right) =>
    left.pageUrl.localeCompare(right.pageUrl) || left.linkResultKey.localeCompare(right.linkResultKey))
  for (const candidate of sorted) {
    if (candidate.isImageLink) continue
    const normalizedUrl = normalizeAiTargetUrl(candidate.resolvedUrl) ?? (candidate.resolvedUrl || candidate.href)
    if (!normalizedUrl) continue
    const sourceMasking = new AiMaskingAccumulator()
    const dedupeKey = sha256(stableStringify({
      linkText: maskAndLimit(sourceMasking, 'text', candidate.linkText, 10_000, 'start'),
      beforeText: maskAndLimit(sourceMasking, 'text', candidate.beforeText, AI_SOURCE_CONTEXT_LIMIT, 'end'),
      afterText: maskAndLimit(sourceMasking, 'text', candidate.afterText, AI_SOURCE_CONTEXT_LIMIT, 'start'),
      normalizedUrl: maskAndLimit(sourceMasking, 'url', normalizedUrl, 4_096, 'start'),
    }))
    const group = groups.get(dedupeKey)
    if (group) group.candidates.push(candidate)
    else groups.set(dedupeKey, { dedupeKey, candidates: [candidate] })
  }
  return [...groups.values()].sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey))
}

function normalizeAiTargetUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

async function getTarget(value: string, probe: LinkProbe, cache: Map<string, Promise<RawTarget>>): Promise<RawTarget> {
  const normalizedUrl = normalizeAiTargetUrl(value)
  if (!normalizedUrl) {
    return unavailable(value, 'unsupported_protocol', 'HTTP/HTTPS以外のリンクはAI判定対象外です。')
  }
  if (/\.pdf(?:$|[?#])/iu.test(normalizedUrl)) {
    return unavailable(normalizedUrl, 'pdf', 'PDFはAIリンク内容判定の対象外です。')
  }
  const pending = cache.get(normalizedUrl) ?? fetchTarget(normalizedUrl, probe)
  cache.set(normalizedUrl, pending)
  return pending
}

async function fetchTarget(normalizedUrl: string, probe: LinkProbe): Promise<RawTarget> {
  try {
    const response = await probe.probe(normalizedUrl, true)
    if (response.status < 200 || response.status >= 300) {
      return unavailable(normalizedUrl, 'http_error', `リンク先を取得できませんでした（HTTP ${response.status}）。`, response.finalUrl)
    }
    if (!/(?:text\/html|application\/xhtml\+xml)/iu.test(response.contentType)) {
      return unavailable(normalizedUrl, 'non_html', 'リンク先がHTMLではないため内容を抽出できません。', response.finalUrl)
    }
    const extracted = extractAiTargetContent(response.body ?? '')
    return {
      normalizedUrl,
      finalUrl: response.finalUrl,
      ...extracted,
      fetchStatus: 'available',
    }
  } catch {
    return unavailable(normalizedUrl, 'fetch_failed', 'AI判定用のリンク先情報を安全に取得できませんでした。')
  }
}

interface RawTarget extends AiLinkTarget {}

function unavailable(
  normalizedUrl: string,
  fetchStatus: RawTarget['fetchStatus'],
  unavailableReason: string,
  finalUrl?: string,
): RawTarget {
  return { normalizedUrl, finalUrl, headings: [], bodyExcerpt: '', fetchStatus, unavailableReason }
}

function maskTarget(value: RawTarget, masking: AiMaskingAccumulator): AiLinkTarget {
  return {
    normalizedUrl: maskAndLimit(masking, 'url', value.normalizedUrl, 4_096, 'start'),
    finalUrl: value.finalUrl ? maskAndLimit(masking, 'url', value.finalUrl, 4_096, 'start') : undefined,
    title: value.title ? maskAndLimit(masking, 'text', value.title, 10_000, 'start') : undefined,
    headings: value.headings.map(heading => ({
      ...heading,
      text: maskAndLimit(masking, 'text', heading.text, 10_000, 'start'),
    })),
    bodyExcerpt: maskAndLimit(masking, 'text', value.bodyExcerpt, AI_BODY_EXCERPT_LIMIT, 'start'),
    fetchStatus: value.fetchStatus,
    unavailableReason: value.unavailableReason
      ? maskAndLimit(masking, 'text', value.unavailableReason, 2_000, 'start')
      : undefined,
  }
}

function maskAndLimit(
  masking: AiMaskingAccumulator,
  kind: 'text' | 'url',
  value: string,
  limit: number,
  side: 'start' | 'end',
): string {
  return limitCodePoints(kind === 'url' ? masking.url(value) : masking.text(value), limit, side)
}

function removeNonContent(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg|form|textarea|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(?:input|option)\b[^>]*\/?\s*>/giu, ' ')
}

function htmlFragmentToText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim()
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (match, decimal, hexadecimal, name) => {
    if (decimal) return safeCodePoint(Number(decimal), match)
    if (hexadecimal) return safeCodePoint(Number.parseInt(hexadecimal, 16), match)
    return named[String(name).toLowerCase()] ?? match
  })
}

function safeCodePoint(value: number, fallback: string): string {
  try {
    return String.fromCodePoint(value)
  } catch {
    return fallback
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmac(value: string, key: Uint8Array): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex')
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]))
  }
  return value
}
