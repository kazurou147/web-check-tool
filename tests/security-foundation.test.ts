import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SECURITY_ERROR_CODES,
  SECURITY_LIMITS,
  SecurityFoundationError,
} from '~/shared/security/security-constants'
import {
  hasUrlUserinfo,
  inspectUrlSecrets,
  isSensitiveQueryName,
  maskUrlForDisplay,
  normalizeHttpUrlForIdentity,
  URL_MASKING_NOTICE,
  URL_REDACTION_MARKER,
} from '~/shared/security/url-security'
import {
  createUrlIdentity,
  createUrlIdentityKey,
  deriveUrlIdentityKey,
  loadUrlIdentityKey,
  URL_IDENTITY_KEY_FILE,
} from '~/server/services/url-identity'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Security-A URL安全化', () => {
  it.each([
    'token', 'TOKEN', 'access_token', 'access-token', 'accessToken',
    'refresh_token', 'refreshToken', 'api_key', 'api-key', 'apiKey',
    'key', 'secret', 'auth', 'password', 'session', 'session_id', 'sid', 'cookie',
  ])('%sを秘密クエリ名として扱う', (name) => {
    expect(isSensitiveQueryName(name)).toBe(true)
  })

  it('秘密クエリだけをマスクし、入力URLと通常クエリを変更しない', () => {
    const original = 'https://example.com/path?token=secret&lang=ja&token=second'
    const masked = maskUrlForDisplay(original)
    const parsed = new URL(masked.value)

    expect(original).toBe('https://example.com/path?token=secret&lang=ja&token=second')
    expect(parsed.searchParams.getAll('token')).toEqual([URL_REDACTION_MARKER, URL_REDACTION_MARKER])
    expect(parsed.searchParams.get('lang')).toBe('ja')
    expect(masked).toMatchObject({ maskedCount: 2, sensitiveQueryNames: ['token'] })
    expect(masked.notice).toBe(URL_MASKING_NOTICE)
  })

  it('URLエンコードされたクエリ名とUTF-8 URLを安全化する', () => {
    const masked = maskUrlForDisplay('https://例え.jp/犬?%74%6f%6b%65%6e=秘密&検索=柴犬')
    const parsed = new URL(masked.value)

    expect(parsed.hostname).toBe('xn--r8jz45g.jp')
    expect(parsed.pathname).toBe('/%E7%8A%AC')
    expect(parsed.searchParams.get('token')).toBe(URL_REDACTION_MARKER)
    expect(parsed.searchParams.get('検索')).toBe('柴犬')
    expect(masked.value).not.toContain(encodeURIComponent('秘密'))
  })

  it('userinfoを検出し、表示用URLではusernameとpasswordを個別にマスクする', () => {
    const value = 'https://alice:password@example.com/private?lang=ja'
    const inspected = inspectUrlSecrets(value)
    const masked = maskUrlForDisplay(value)
    const parsed = new URL(masked.value)

    expect(hasUrlUserinfo(value)).toBe(true)
    expect(inspected).toEqual({ hasUserinfo: true, sensitiveQueryNames: [], hasDetectedSecrets: true })
    expect(decodeURIComponent(parsed.username)).toBe(URL_REDACTION_MARKER)
    expect(decodeURIComponent(parsed.password)).toBe(URL_REDACTION_MARKER)
    expect(masked.maskedCount).toBe(2)
    expect(masked.maskedCategories).toEqual(['url_userinfo'])
  })

  it('似ているだけの通常クエリはマスクせず、自動判定の限界を通知する', () => {
    const masked = maskUrlForDisplay('https://example.com/?monkey=banana&keyboard=jp')

    expect(masked.maskedCount).toBe(0)
    expect(masked.value).toContain('monkey=banana')
    expect(masked.notice).toContain('すべての秘密情報を検出できることを保証しません')
  })

  it('識別用正規化は既存規則どおりHTTP/HTTPSを限定しフラグメントだけを除去する', () => {
    expect(normalizeHttpUrlForIdentity('HTTPS://EXAMPLE.COM:443/a/../犬?b=2&a=1#章')).toBe(
      'https://example.com/%E7%8A%AC?b=2&a=1',
    )
    expect(() => normalizeHttpUrlForIdentity('mailto:test@example.com')).toThrowError(
      expect.objectContaining({ code: SECURITY_ERROR_CODES.unsupportedUrlProtocol }),
    )
  })
})

describe('Security-A URL同一性HMAC', () => {
  it('同じ鍵と正規化URLから安定した識別子を生成し、元URLを含めない', () => {
    const key = randomBytes(32)
    const first = createUrlIdentity('https://EXAMPLE.com:443/path?token=one#first', key)
    const second = createUrlIdentity('https://example.com/path?token=one#second', key)

    expect(first).toBe(second)
    expect(first).toMatch(/^url-hmac-v1:[0-9a-f]{64}$/)
    expect(first).not.toContain('token')
    expect(first).not.toContain('one')
  })

  it('異なる秘密値と異なる鍵では異なる識別子を生成する', () => {
    const key = randomBytes(32)
    expect(createUrlIdentity('https://example.com/?token=one', key)).not.toBe(
      createUrlIdentity('https://example.com/?token=two', key),
    )
    expect(createUrlIdentity('https://example.com/?token=one', key)).not.toBe(
      createUrlIdentity('https://example.com/?token=one', randomBytes(32)),
    )
  })

  it('AI署名鍵と異なる用途文字列で環境鍵から導出する', () => {
    const master = randomBytes(32).toString('base64')
    const derived = deriveUrlIdentityKey(master)
    const directAiStyle = Buffer.from(master, 'base64')

    expect(derived).toHaveLength(32)
    expect(derived.equals(directAiStyle)).toBe(false)
  })

  it('鍵の作成と再読込が安定し、既存鍵を上書きしない', async () => {
    const dataDir = await temporaryDataDir()
    const created = await createUrlIdentityKey(dataDir)
    const loaded = await loadUrlIdentityKey(dataDir)
    const stored = await readFile(join(dataDir, URL_IDENTITY_KEY_FILE), 'utf8')

    expect(created.equals(loaded)).toBe(true)
    expect(Buffer.from(stored.trim(), 'base64').equals(created)).toBe(true)
    await expect(createUrlIdentityKey(dataDir)).rejects.toMatchObject({
      code: SECURITY_ERROR_CODES.urlIdentityKeyExists,
    })
  })

  it('鍵が欠落しても自動生成せず、安全なエラーで失敗する', async () => {
    const dataDir = await temporaryDataDir()

    await expect(loadUrlIdentityKey(dataDir)).rejects.toMatchObject({
      code: SECURITY_ERROR_CODES.urlIdentityKeyMissing,
    })
    await expect(readFile(join(dataDir, URL_IDENTITY_KEY_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('破損鍵と不正な鍵長を安全なコードで拒否する', async () => {
    const dataDir = await temporaryDataDir()
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, URL_IDENTITY_KEY_FILE), 'invalid\n', 'utf8')

    await expect(loadUrlIdentityKey(dataDir)).rejects.toMatchObject({
      code: SECURITY_ERROR_CODES.urlIdentityKeyInvalid,
    })
    expect(() => createUrlIdentity('https://example.com/', randomBytes(16))).toThrowError(
      expect.objectContaining({ code: SECURITY_ERROR_CODES.urlIdentityKeyInvalid }),
    )
    expect(() => deriveUrlIdentityKey(`${randomBytes(32).toString('base64')}!`)).toThrowError(
      expect.objectContaining({ code: SECURITY_ERROR_CODES.urlIdentityKeyInvalid }),
    )
  })
})

describe('Security-A 共通定数と安全なエラー', () => {
  it('後続フェーズ用の確定初期値を一元管理する', () => {
    expect(Object.isFrozen(SECURITY_LIMITS)).toBe(true)
    expect(SECURITY_LIMITS).toEqual({
      linkRequestConcurrencyPerRun: 8,
      linkRequestConcurrencyPerOrigin: 4,
      runResultHardBytes: 50 * 1024 * 1024,
      runResultOperationalBudgetBytes: 48 * 1024 * 1024,
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
      excelReportRows: 100_000,
      excelReportBytes: 50 * 1024 * 1024,
    })
  })

  it('エラーは秘密値を含まない安定コードを持つ', () => {
    const error = new SecurityFoundationError(
      SECURITY_ERROR_CODES.urlIdentityKeyMissing,
      'URL識別鍵が見つかりません。',
    )
    expect(error.name).toBe('SecurityFoundationError')
    expect(error.code).toBe('SECURITY_URL_IDENTITY_KEY_MISSING')
    expect(error.message).not.toContain('token=')
  })
})

async function temporaryDataDir(): Promise<string> {
  const path = await mkdtemp(join(process.cwd(), '.test-data-security-a-'))
  temporaryDirectories.push(path)
  return path
}
