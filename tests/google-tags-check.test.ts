import { describe, expect, it } from 'vitest'
import { checkGoogleTags } from '~/server/services/checks/google-tags'
import type { ExpectedGoogleTag } from '~/shared/types/excel-input'

const gtmHead: ExpectedGoogleTag = {
  sourceRow: 2,
  name: 'GTM head',
  code: '<script>GTM-ABC123</script>',
  ids: [{ id: 'GTM-ABC123', type: 'gtm' }],
  placement: 'head',
}
const gtmBody: ExpectedGoogleTag = {
  sourceRow: 3,
  name: 'GTM body',
  code: '<noscript>GTM-ABC123</noscript>',
  ids: [{ id: 'GTM-ABC123', type: 'gtm' }],
  placement: 'body',
}

function inspect(overrides: Partial<Parameters<typeof checkGoogleTags>[0]> = {}) {
  return checkGoogleTags({
    pageUrl: 'https://example.com/',
    pageNames: ['トップ'],
    sourceRows: [2],
    rawHtml: '<html><head></head><body></body></html>',
    renderedHtml: '<html><head></head><body></body></html>',
    network: [],
    expected: [],
    ...overrides,
  })
}

describe('Googleタグ検査', () => {
  it('GTM直接設置とGTM経由GA4を正常として区別する', () => {
    const html = '<html><head><script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script></head><body><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC123"></iframe></noscript></body></html>'
    const result = inspect({
      rawHtml: html,
      renderedHtml: `${html}<script>G-GA123</script>`,
      expected: [gtmHead, gtmBody],
      network: [
        { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123', initiatorUrls: [] },
        { url: 'https://www.google-analytics.com/g/collect?tid=G-GA123', initiatorUrls: ['https://www.googletagmanager.com/gtm.js?id=GTM-ABC123'] },
      ],
    })

    expect(result.finding.verdict, JSON.stringify(result, null, 2)).toBe('ok')
    expect(result.detections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'GTM-ABC123', detectionMethod: 'html_direct', installationMethod: 'direct' }),
      expect.objectContaining({ id: 'G-GA123', detectionMethod: 'gtm_delivered', installationMethod: 'gtm', verdict: 'ok' }),
    ]))
  })

  it('正常なGTM head/body組合せを重複にせず、余分なheadコードはNGにする', () => {
    const normal = '<html><head><script>GTM-ABC123</script></head><body><noscript>GTM-ABC123</noscript></body></html>'
    const duplicate = '<html><head><script>GTM-ABC123</script><script>GTM-ABC123</script></head><body><noscript>GTM-ABC123</noscript></body></html>'

    expect(inspect({ rawHtml: normal, renderedHtml: normal, expected: [gtmHead, gtmBody] }).finding.verdict).toBe('ok')
    expect(inspect({ rawHtml: duplicate, renderedHtml: duplicate, expected: [gtmHead, gtmBody] }).finding.verdict).toBe('ng')
  })

  it('DOMと通信の同一IDを不適切な重複と判定しない', () => {
    const html = '<html><head><script src="https://www.googletagmanager.com/gtag/js?id=G-DIRECT1"></script><script>gtag("config", "G-DIRECT1")</script></head><body></body></html>'
    const result = inspect({
      rawHtml: html,
      renderedHtml: html,
      expected: [{ sourceRow: 2, name: 'GA4', code: 'G-DIRECT1', ids: [{ id: 'G-DIRECT1', type: 'ga4' }], placement: 'unspecified' }],
      network: [{ url: 'https://www.google-analytics.com/g/collect?tid=G-DIRECT1', initiatorUrls: [] }],
    })

    expect(result.finding.verdict, JSON.stringify(result, null, 2)).toBe('ok')
    expect(result.detections.filter(item => item.id === 'G-DIRECT1')).toHaveLength(2)
    expect(result.detections.find(item => item.detectionMethod === 'network')).toMatchObject({ installationMethod: 'direct', verdict: 'ok' })
  })

  it('想定外のHTML直接設置をNGにする', () => {
    const html = '<html><head><script>gtag("config", "AW-999")</script></head><body></body></html>'
    const result = inspect({ rawHtml: html, renderedHtml: html })
    expect(result.finding.verdict).toBe('ng')
    expect(result.detections[0]).toMatchObject({ id: 'AW-999', detectionMethod: 'html_direct', verdict: 'ng' })
  })

  it('通信だけで設置方法不明なら要確認にする', () => {
    const result = inspect({
      network: [{ url: 'https://www.google-analytics.com/g/collect?tid=G-NETWORK1', initiatorUrls: [] }],
    })
    expect(result.finding.verdict).toBe('needs_review')
    expect(result.detections[0]).toMatchObject({ detectionMethod: 'network', installationMethod: 'unknown', verdict: 'needs_review' })
  })

  it('Google広告とFloodlightの通信URLからIDを抽出する', () => {
    const result = inspect({
      network: [
        { url: 'https://www.googleadservices.com/pagead/conversion/123456/?label=x', initiatorUrls: [] },
        { url: 'https://ad.doubleclick.net/activity;src=987654;type=test', initiatorUrls: [] },
      ],
    })
    expect(result.detections.map(item => item.id)).toEqual(expect.arrayContaining(['AW-123456', 'DC-987654']))
    expect(result.finding.verdict).toBe('needs_review')
  })

  it('期待0件でGTM経由タグだけなら対象外としてOK件数に加えない状態にする', () => {
    const result = inspect({
      network: [{
        url: 'https://www.google-analytics.com/g/collect?tid=G-GA123',
        initiatorUrls: ['https://www.googletagmanager.com/gtm.js?id=GTM-ABC123'],
      }],
    })
    expect(result.finding).toMatchObject({ verdict: 'ok', detailStatus: 'not_applicable' })
  })

  it('期待IDの欠落をNGにする', () => {
    const result = inspect({ expected: [gtmHead] })
    expect(result.finding.verdict).toBe('ng')
    expect(result.finding.message).toContain('期待タグ GTM-ABC123')
  })
})
