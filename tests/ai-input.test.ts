import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_BODY_EXCERPT_LIMIT,
  AI_SOURCE_CONTEXT_LIMIT,
  aiInputBundleSchema,
  buildAiInputBundle,
  extractAnchorTarget,
  extractAiTargetContent,
  limitCodePoints,
  loadOrCreateAiSigningKey,
  verifyAiInputBundle,
  type AiSourceCandidate,
} from '~/server/services/ai-input'
import { maskSecretText, maskSensitiveText, maskSensitiveUrl } from '~/server/services/ai-masking'
import { SafeLinkProbe, type LinkProbe } from '~/server/services/checks/links'
import { NetworkPolicy } from '~/server/services/network-policy'

const projectId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const bundleId = '33333333-3333-4333-8333-333333333333'
const signingKey = randomBytes(32)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

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

  it.each([
    'https://dcmh.test-kazurou147.biz/wp-content/themes/dcmh/img/logo.png',
    'https://dcmh.test-kazurou147.biz/wp-content/uploads/2026/10/very-long-descriptive-image-file-name-for-delivery-check.jpeg',
    'https://cdn.example.com/assets/0123456789abcdef0123456789abcdef0123456789abcdef.svg',
    'https://cdn.example.com/assets/hero-image.webp',
    'https://cdn.example.com/assets/photo.avif',
  ])('本文中の通常画像URLを高エントロピー値としてマスクしない: %s', (imageUrl) => {
    const masked = maskSecretText(`desktop ${imageUrl}: 画像の通信エラーを確認しました。`)

    expect(masked.value).toContain(imageUrl)
    expect(masked.value).not.toContain('[MASKED_HIGH_ENTROPY]')
  })

  it('本文中の画像URLでもユーザー情報・秘密クエリ・署名パラメータだけを保護する', () => {
    const imageUrl = 'https://user:pass@cdn.example.com/assets/0123456789abcdef0123456789abcdef0123456789abcdef.png?size=large&token=plain-secret&X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=signed-secret-value'
    const masked = maskSecretText(`desktop ${imageUrl}: 画像の通信エラーを確認しました。`)

    expect(masked.value).toContain('cdn.example.com/assets/0123456789abcdef0123456789abcdef0123456789abcdef.png')
    expect(masked.value).toContain('size=large')
    expect(masked.value).not.toContain('user:pass')
    expect(masked.value).not.toContain('plain-secret')
    expect(masked.value).not.toContain('AKIAEXAMPLE')
    expect(masked.value).not.toContain('signed-secret-value')
    expect(masked.maskedCategories).toContain('url_credentials')
    expect(masked.maskedCategories).toContain('url_query_secret')
  })

  it('URLマスキングを繰り返しても通常パスを損なわない', () => {
    const imageUrl = 'https://cdn.example.com/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.webp?token=secret'
    const once = maskSecretText(imageUrl).value
    const twice = maskSecretText(once).value

    expect(twice).toBe(once)
    expect(twice).toContain('/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.webp')
  })

  it('上限長の文章がマスキングで伸長しても、マスキング後の値を契約上限へ収める', async () => {
    const email = 'a@b.co'
    const beforeText = `${'前'.repeat(194)}${email}`
    const afterText = `${email}${'後'.repeat(194)}`
    const body = `${email}${'本'.repeat(AI_BODY_EXCERPT_LIMIT - Array.from(email).length)}`
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [{ ...candidate('masked-limit'), beforeText, afterText }],
      probe: {
        probe: async url => ({
          requestedUrl: url,
          finalUrl: url,
          status: 200,
          contentType: 'text/html',
          redirectCount: 0,
          body: `<html><head><title>確認</title></head><body><p>${body}</p></body></html>`,
        }),
      },
      signingKey,
      createBundleId: () => bundleId,
    })

    expect(Array.from(bundle.items[0]!.source.beforeText)).toHaveLength(AI_SOURCE_CONTEXT_LIMIT)
    expect(Array.from(bundle.items[0]!.source.afterText)).toHaveLength(AI_SOURCE_CONTEXT_LIMIT)
    expect(Array.from(bundle.items[0]!.target.bodyExcerpt)).toHaveLength(AI_BODY_EXCERPT_LIMIT)
    expect(JSON.stringify(bundle)).not.toContain(email)
    expect(aiInputBundleSchema.safeParse(bundle).success).toBe(true)
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

  it('正常な同一ページ内アンカーのURL・対象ID・見出し・周辺文を保持し、HTTP取得にはフラグメントを送らない', async () => {
    const probe = vi.fn(async (url: string) => ({
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      redirectCount: 0,
      body: '<title>規約</title><body><p>前の説明</p><h2 id="contact">お問い合わせ</h2><p>フォームからご連絡ください。secret@example.com</p></body>',
    }))
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [{
        ...candidate('same-page-anchor'),
        pageUrl: 'https://source.example/privacy',
        href: '#contact',
        resolvedUrl: 'https://source.example/privacy#contact',
        linkText: 'お問い合わせ',
      }],
      probe: { probe },
      signingKey,
      createBundleId: () => bundleId,
    })

    expect(probe).toHaveBeenCalledWith('https://source.example/privacy', true)
    expect(bundle.items[0]!.source).toMatchObject({
      linkUrl: 'https://source.example/privacy#contact',
      urlFragment: 'contact',
      isSamePageAnchor: true,
    })
    expect(bundle.items[0]!.target.anchor).toMatchObject({
      fragment: 'contact',
      found: true,
      targetId: 'contact',
      heading: { level: 2, text: 'お問い合わせ' },
    })
    expect(bundle.items[0]!.target.anchor?.surroundingText).toContain('フォームからご連絡ください')
    expect(JSON.stringify(bundle)).not.toContain('secret@example.com')
  })

  it('異なるページへのアンカーを同一ページ扱いせず、取得先から対象要素を抽出する', async () => {
    const probe = vi.fn(async (url: string) => ({
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      redirectCount: 0,
      body: '<body><h3 id="details">料金詳細</h3><p>月額料金を説明します。</p></body>',
    }))
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [{ ...candidate('cross-page-anchor'), resolvedUrl: 'https://target.example/pricing#details' }],
      probe: { probe },
      signingKey,
      createBundleId: () => bundleId,
    })

    expect(bundle.items[0]!.source.isSamePageAnchor).toBe(false)
    expect(bundle.items[0]!.target.anchor?.heading).toEqual({ level: 3, text: '料金詳細' })
    expect(probe).toHaveBeenCalledWith('https://target.example/pricing', true)
  })

  it('同じ取得URLでも異なるフラグメントは別itemとし、HTML取得だけを共有する', async () => {
    const probe = vi.fn(async (url: string) => ({
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      redirectCount: 0,
      body: '<body><h2 id="first">第一章</h2><p>一つ目</p><h2 id="second">第二章</h2><p>二つ目</p></body>',
    }))
    const base = { ...candidate('fragment-one'), linkText: '章へ', beforeText: '', afterText: '' }
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [
        { ...base, resolvedUrl: 'https://target.example/guide#first' },
        { ...base, linkResultKey: 'fragment-two', resolvedUrl: 'https://target.example/guide#second' },
      ],
      probe: { probe },
      signingKey,
      createBundleId: () => bundleId,
    })

    expect(bundle.items).toHaveLength(2)
    expect(new Set(bundle.items.map(item => item.itemId)).size).toBe(2)
    expect(bundle.items.map(item => item.source.urlFragment).sort()).toEqual(['first', 'second'])
    expect(bundle.items.map(item => item.target.anchor?.targetId).sort()).toEqual(['first', 'second'])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('存在しないフラグメントはfound=falseとして保持し、通常リンクにはアンカー情報を付けない', async () => {
    const probe = vi.fn(async (url: string) => ({
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      contentType: 'text/html',
      redirectCount: 0,
      body: '<body><h1 id="present">存在する見出し</h1></body>',
    }))
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [
        { ...candidate('missing-anchor'), linkText: '不足', resolvedUrl: 'https://target.example/dogs#missing' },
        { ...candidate('normal-link'), linkText: '通常', resolvedUrl: 'https://target.example/dogs' },
      ],
      probe: { probe },
      signingKey,
      createBundleId: () => bundleId,
    })
    const missing = bundle.items.find(item => item.source.urlFragment === 'missing')!
    const normal = bundle.items.find(item => item.source.linkText === '通常')!

    expect(missing.target.anchor).toEqual({ fragment: 'missing', found: false })
    expect(normal.source.urlFragment).toBeUndefined()
    expect(normal.source.isSamePageAnchor).toBe(false)
    expect(normal.target.anchor).toBeUndefined()
  })

  it('旧AI入力のsource・targetにアンカー拡張がなくても読み込める', async () => {
    const bundle = await buildAiInputBundle({
      projectId,
      runId,
      candidates: [candidate('legacy-compatible')],
      probe: successfulProbe(),
      signingKey,
      createBundleId: () => bundleId,
    })
    const legacy = structuredClone(bundle) as unknown as Record<string, unknown>
    const item = (legacy.items as Array<Record<string, unknown>>)[0]!
    const source = item.source as Record<string, unknown>
    delete source.linkUrl
    delete source.urlFragment
    delete source.isSamePageAnchor
    delete (item.target as Record<string, unknown>).anchor
    legacy.contractVersion = '1.0.0'
    legacy.promptVersion = '1.1.0'

    expect(aiInputBundleSchema.safeParse(legacy).success).toBe(true)
  })

  it('アンカー抽出はURLエンコードされた日本語IDとa[name]に対応する', () => {
    expect(extractAnchorTarget('<body><h2 id="お問い合わせ">連絡先</h2></body>', '%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B')).toMatchObject({
      found: true,
      targetId: 'お問い合わせ',
      heading: { level: 2, text: '連絡先' },
    })
    expect(extractAnchorTarget('<body><a name="legacy"></a><p>旧形式の位置</p></body>', 'legacy')).toMatchObject({
      found: true,
      targetId: 'legacy',
    })
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

  it('環境鍵がなくてもローカル署名鍵を生成し、再起動相当でも同じ鍵を再利用する', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-ai-signing-'))
    temporaryDirectories.push(directory)
    const projectsDir = join(directory, 'projects')

    const first = await loadOrCreateAiSigningKey(projectsDir)
    const second = await loadOrCreateAiSigningKey(projectsDir)
    const stored = await readFile(join(directory, '.ai-signing-key'), 'utf8')

    expect(first).toHaveLength(32)
    expect(second.equals(first)).toBe(true)
    expect(Buffer.from(stored.trim(), 'base64').equals(first)).toBe(true)
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
