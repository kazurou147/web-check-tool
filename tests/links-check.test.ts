import { describe, expect, it } from 'vitest'
import { checkLinks, SafeLinkProbe, verdictForStatus, type LinkProbe } from '~/server/services/checks/links'
import { NetworkPolicy } from '~/server/services/network-policy'

describe('リンク検査', () => {
  it.each([
    [200, 'ok'], [301, 'ng'], [400, 'ng'], [401, 'needs_review'], [403, 'needs_review'],
    [404, 'ng'], [405, 'needs_review'], [429, 'needs_review'], [500, 'ng'],
  ] as const)('HTTP %iを%sと判定する', (status, verdict) => {
    expect(verdictForStatus(status)).toBe(verdict)
  })

  it('HTTP、ページ内/別ページアンカー、mailto、tel、画像リンクを検査する', async () => {
    const probe: LinkProbe = {
      probe: async (url, includeBody) => ({
        requestedUrl: url,
        finalUrl: url,
        status: url.includes('forbidden') ? 403 : 200,
        contentType: 'text/html',
        redirectCount: 0,
        body: includeBody ? '<h2 id="target">Target</h2>' : undefined,
      }),
    }
    const results = await checkLinks('https://example.com/', [
      { href: '/ok', resolvedUrl: 'https://example.com/ok', text: 'ok', isImageLink: true },
      { href: '#local', resolvedUrl: 'https://example.com/#local', text: 'local', isImageLink: false },
      { href: '/other#target', resolvedUrl: 'https://example.com/other#target', text: 'other', isImageLink: false },
      { href: 'mailto:test@example.com', resolvedUrl: 'mailto:test@example.com', text: 'mail', isImageLink: false },
      { href: 'tel:+81-3-1234-5678', resolvedUrl: 'tel:+81-3-1234-5678', text: 'tel', isImageLink: false },
      { href: '/forbidden', resolvedUrl: 'https://example.com/forbidden', text: '403', isImageLink: false },
    ], new Set(['local']), probe)

    expect(results.map(item => item.verdict)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'needs_review'])
    expect(results[0].isImageLink).toBe(true)
  })

  it('リダイレクトごとにSSRFを検証して私設IPを拒否する', async () => {
    const policy = new NetworkPolicy({ lookup: async hostname => hostname === 'safe.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }] })
    const fetcher = (async (url: string) => new Response('', {
      status: 302,
      headers: { location: url.includes('safe.example') ? 'http://internal.example/secret' : '/again' },
    })) as typeof fetch
    const probe = new SafeLinkProbe(policy, { timeoutMs: 1_000, maxRedirects: 5, maxResponseBytes: 1_024 }, fetcher)

    await expect(probe.probe('https://safe.example/', false)).rejects.toThrow('ローカル・私設')
  })

  it('リダイレクト回数を上限で停止する', async () => {
    const policy = new NetworkPolicy({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] })
    const fetcher = (async () => new Response('', { status: 302, headers: { location: '/next' } })) as typeof fetch
    const probe = new SafeLinkProbe(policy, { timeoutMs: 1_000, maxRedirects: 1, maxResponseBytes: 1_024 }, fetcher)

    await expect(probe.probe('https://safe.example/', false)).rejects.toThrow('リダイレクト回数')
  })
})
