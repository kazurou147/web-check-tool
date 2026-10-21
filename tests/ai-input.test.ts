import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  AI_BODY_EXCERPT_LIMIT,
  AI_SOURCE_CONTEXT_LIMIT,
  aiInputBundleSchema,
  buildAiInputBundle,
  extractAiTargetContent,
  limitCodePoints,
  verifyAiInputBundle,
  type AiSourceCandidate,
} from '~/server/services/ai-input'
import { maskSensitiveText, maskSensitiveUrl } from '~/server/services/ai-masking'
import { SafeLinkProbe, type LinkProbe } from '~/server/services/checks/links'
import { NetworkPolicy } from '~/server/services/network-policy'

const projectId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const bundleId = '33333333-3333-4333-8333-333333333333'
const signingKey = randomBytes(32)

describe('Phase 5-A AI入力共通基盤', () => {
  it('日本語と絵文字をコードポイント単位で前後200文字に切り出す', () => {
    const value = `${'前'.repeat(199)}🐕${'後'.repeat(10)}`
    const start = limitCodePoints(value, AI_SOURCE_CONTEXT_LIMIT, 'start')
    const end = limitCodePoints(value, AI_SOURCE_CONTEXT_LIMIT, 'end')

    expect(Array.from(start)).toHaveLength(200)
    expect(start.endsWith('🐕')).toBe(true)
    expect(Array.from(end)).toHaveLength(200)
    expect(end.includes('🐕')).toBe(true)
  })

  it('title、h1〜h3と本文冒頭3000文字を抽出し、フォームとスクリプトを除外する', () => {
    const html = `<html><head><title>犬 &amp; 猫</title></head><body>
      <h1>見出し <em>一</em></h1><h2>見出し二</h2><h3>見出し三</h3><h4>対象外</h4>
      <script>secret-script</script><form><input value="secret-form">secret-form</form>
      <p>${'本文'.repeat(2_000)}</p></body></html>`
    const result = extractAiTargetContent(html)

    expect(result.title).toBe('犬 & 猫')
    expect(result.headings).toEqual([
      { level: 1, text: '見出し 一' },
      { level: 2, text: '見出し二' },
      { level: 3, text: '見出し三' },
    ])
    expect(Array.from(result.bodyExcerpt)).toHaveLength(AI_BODY_EXCERPT_LIMIT)
    expect(result.bodyExcerpt).not.toContain('secret-script')
    expect(result.bodyExcerpt).not.toContain('secret-form')
  })

  it('秘密情報を共通規則でマスクし、種類と件数を返す', () => {
    const text = maskSensitiveText('mail=a@example.com tel=03-1234-5678 Authorization: Bearer abc\ntoken=supersecret eyJabcdefgh.abcdefgh.abcdefgh')
    const url = maskSensitiveUrl('https://user:pass@example.com/path?token=secret&safe=yes')

    expect(text.value).not.toContain('a@example.com')
    expect(text.value).not.toContain('03-1234-5678')
    expect(text.value).not.toContain('supersecret')
    expect(text.maskedCategories).toEqual(expect.arrayContaining(['email', 'phone', 'secret_header', 'named_secret', 'jwt']))
    expect(text.maskedCount).toBeGreaterThanOrEqual(5)
    expect(url.value).not.toContain('user:pass')
    expect(url.value).not.toContain('secret')
    expect(url.maskedCategories).toEqual(expect.arrayContaining(['url_credentials', 'url_query_secret']))
  })

  it('複数URLを含む識別子と不正URLでも再帰せず秘密値をマスクする', () => {
    const key = maskSensitiveText('https://source.example/?session=one|link|0|https://target.example/?token=two')
    const invalid = maskSensitiveUrl('https://%invalid/?token=secret')

    expect(key.value).not.toContain('one')
    expect(key.value).not.toContain('two')
    expect(key.maskedCount).toBe(2)
    expect(invalid.value).not.toContain('secret')
  })

  it('画像リンクを除外し、同一入力をまとめ、同じリンク先を1回だけ取得する', async () => {
    const probe = vi.fn(async (url: string) => ({
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html; charset=utf-8',
      redirectCount: 0,
      body: '<title>移動先</title><body><h1>犬のページ</h1><p>本文です。</p></body>',
    }))
    const candidates = [
      candidate('link-1'),
      { ...candidate('link-2'), pageUrl: 'https://source.example/other' },
      { ...candidate('link-3'), beforeText: '別の文脈' },
      { ...candidate('image'), isImageLink: true },
    ]
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates,
      probe: { probe } satisfies LinkProbe,
      signingKey,
      now: () => new Date('2026-10-21T00:00:00.000Z'),
      createBundleId: () => bundleId,
    })

    expect(bundle.items).toHaveLength(2)
    expect(bundle.items[0].sourceReferences.map(item => item.linkResultKey)).toEqual(['link-1', 'link-2'])
    expect(bundle.items.flatMap(item => item.sourceReferences)).not.toEqual(expect.arrayContaining([expect.objectContaining({ linkResultKey: 'image' })]))
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith('https://target.example/dogs', true)
    expect(bundle.contentTreatment).toBe('untrusted_data')
  })

  it('PDFは取得せず取得不能理由を保持する', async () => {
    const probe = vi.fn()
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [{ ...candidate('pdf'), href: '/guide.pdf', resolvedUrl: 'https://target.example/guide.pdf' }],
      probe: { probe } as LinkProbe,
      signingKey,
      createBundleId: () => bundleId,
    })

    expect(probe).not.toHaveBeenCalled()
    expect(bundle.items[0].target).toMatchObject({ fetchStatus: 'pdf', bodyExcerpt: '' })
  })

  it('HTTP/HTTPS以外は通信せず取得不能理由を保持する', async () => {
    const probe = vi.fn()
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [{ ...candidate('mail'), href: 'mailto:person@example.com', resolvedUrl: 'mailto:person@example.com' }],
      probe: { probe } as LinkProbe,
      signingKey,
      createBundleId: () => bundleId,
    })

    expect(probe).not.toHaveBeenCalled()
    expect(bundle.items[0].target.fetchStatus).toBe('unsupported_protocol')
    expect(JSON.stringify(bundle)).not.toContain('person@example.com')
  })

  it('入力スキーマとHMAC整合性を検証し、改変を拒否する', async () => {
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [candidate('link-1')],
      probe: successfulProbe(),
      signingKey,
      createBundleId: () => bundleId,
    })

    expect(aiInputBundleSchema.safeParse(bundle).success).toBe(true)
    expect(verifyAiInputBundle(JSON.parse(JSON.stringify(bundle)), signingKey)).toEqual(bundle)

    const tampered = structuredClone(bundle)
    tampered.items[0]!.source.linkText = '改変'
    expect(() => verifyAiInputBundle(tampered, signingKey)).toThrow('ハッシュ')
    expect(() => verifyAiInputBundle(bundle, randomBytes(32))).toThrow('署名')
  })

  it('SSRFで拒否されたリダイレクトは取得失敗として保持し、入力生成全体を失敗させない', async () => {
    const policy = new NetworkPolicy({ lookup: async hostname => hostname === 'safe.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }] })
    const fetcher = vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://internal.example/secret' } })) as unknown as typeof fetch
    const probe = new SafeLinkProbe(policy, { timeoutMs: 1_000, maxRedirects: 5, maxResponseBytes: 1_024 }, fetcher)
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [{ ...candidate('ssrf'), href: 'https://safe.example/', resolvedUrl: 'https://safe.example/' }],
      probe,
      signingKey,
      createBundleId: () => bundleId,
    })

    expect(bundle.items[0].target.fetchStatus).toBe('fetch_failed')
    expect(bundle.items[0].target.unavailableReason).not.toContain('internal.example')
  })
})

function candidate(linkResultKey: string): AiSourceCandidate {
  return {
    linkResultKey,
    pageUrl: 'https://source.example/',
    href: '/dogs',
    resolvedUrl: 'https://target.example/dogs',
    linkText: '犬について',
    beforeText: '詳しくは',
    afterText: 'をご覧ください。',
    isImageLink: false,
  }
}

function successfulProbe(): LinkProbe {
  return {
    probe: async url => ({
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      redirectCount: 0,
      body: '<title>犬</title><body><h1>犬</h1><p>犬の説明</p></body>',
    }),
  }
}
