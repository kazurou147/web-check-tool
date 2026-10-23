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
const googleTag: ExpectedGoogleTag = {
  sourceRow: 4,
  name: 'Google tag (Site Kit)',
  code: '<script src="https://www.googletagmanager.com/gtag/js?id=GT-SITE123"></script><script>gtag("config", "GT-SITE123")</script>',
  ids: [{ id: 'GT-SITE123', type: 'google_tag' }],
  placement: 'unspecified',
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
  it('HTMLへ直接設置されたGoogleタグを期待値と照合して正常検出する', () => {
    const html = `<html><head>${googleTag.code}</head><body></body></html>`
    const result = inspect({ rawHtml: html, renderedHtml: html, expected: [googleTag] })

    expect(result.finding.verdict).toBe('ok')
    expect(result.detections[0]).toMatchObject({
      id: 'GT-SITE123',
      detectionMethod: 'html_direct',
      installationMethod: 'direct',
      location: 'head',
      verdict: 'ok',
    })
  })

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

  it.each([
    [1, '', 'recommended'],
    [2, '<div></div>', 'acceptable_not_first'],
    [3, '<div></div><main></main>', 'acceptable_not_first'],
  ] as const)('GTM bodyコードがbody直下%d番目なら正常範囲として位置を記録する', (position, prefix, status) => {
    const html = `<html><head><script>GTM-ABC123</script></head><body>\n<!-- comment -->${prefix}<noscript>GTM-ABC123</noscript></body></html>`
    const result = inspect({ rawHtml: html, renderedHtml: html, expected: [gtmHead, gtmBody] })
    const detection = result.detections.find(item => item.id === 'GTM-ABC123' && item.detectionMethod === 'html_direct')

    expect(result.finding.verdict).toBe('ok')
    expect(detection?.gtmBodyPlacements).toEqual([expect.objectContaining({
      directBodyChild: true,
      elementPosition: position,
      status,
    })])
    expect(detection?.evidence.join(' ')).toContain('body開始後の生文字距離=')
  })

  it('GTM bodyコードがbody直下4番目以降なら要確認にする', () => {
    const html = '<html><head><script>GTM-ABC123</script></head><body><header></header><nav></nav><main></main><noscript>GTM-ABC123</noscript></body></html>'
    const result = inspect({ rawHtml: html, renderedHtml: html, expected: [gtmHead, gtmBody] })

    expect(result.finding.verdict).toBe('needs_review')
    expect(result.finding.message).toContain('body直下の4番目')
    expect(result.detections[0]?.gtmBodyPlacements?.[0]).toMatchObject({ elementPosition: 4, status: 'too_far' })
  })

  it('GTM bodyコードが別要素内にネストされていれば要確認にする', () => {
    const html = '<html><head><script>GTM-ABC123</script></head><body><div><noscript>GTM-ABC123</noscript></div></body></html>'
    const result = inspect({ rawHtml: html, renderedHtml: html, expected: [gtmHead, gtmBody] })

    expect(result.finding.verdict).toBe('needs_review')
    expect(result.finding.message).toContain('ネスト')
    expect(result.detections[0]?.gtmBodyPlacements?.[0]).toMatchObject({ directBodyChild: false, status: 'nested' })
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

  it('initiatorが直接設置済みGTローダーなら異なるGA4 IDをGoogleタグ経由として関連付ける', () => {
    const html = `<html><head>${googleTag.code}</head><body></body></html>`
    const result = inspect({
      rawHtml: html,
      renderedHtml: html,
      expected: [googleTag],
      network: [{
        url: 'https://www.google-analytics.com/g/collect?tid=G-GA123&en=page_view',
        initiatorUrls: ['https://www.googletagmanager.com/gtag/js?id=GT-SITE123'],
      }],
    })

    const delivered = result.detections.find(item => item.id === 'G-GA123')
    const direct = result.detections.find(item => item.id === 'GT-SITE123' && item.detectionMethod === 'html_direct')
    expect(result.finding.verdict, JSON.stringify(result, null, 2)).toBe('ok')
    expect(delivered).toMatchObject({
      detectionMethod: 'google_tag_delivered',
      installationMethod: 'google_tag',
      sourceTagId: 'GT-SITE123',
      verdict: 'ok',
    })
    expect(delivered?.associationEvidence?.[0]).toContain('HTML直接設置済みGoogleタグ GT-SITE123')
    expect(delivered?.relatedDetectionKeys).toContain(direct?.key)
    expect(direct?.relatedDetectionKeys).toContain(delivered?.key)
  })

  it('異なるIDが同じページにあるだけでは関連付けず要確認を維持する', () => {
    const html = `<html><head>${googleTag.code}</head><body></body></html>`
    const result = inspect({
      rawHtml: html,
      renderedHtml: html,
      expected: [googleTag],
      network: [{
        url: 'https://www.google-analytics.com/g/collect?tid=G-UNKNOWN&en=page_view',
        initiatorUrls: ['https://www.google-analytics.com/internal.js'],
      }],
    })

    expect(result.finding.verdict).toBe('needs_review')
    expect(result.detections.find(item => item.id === 'G-UNKNOWN')).toMatchObject({
      detectionMethod: 'network',
      installationMethod: 'unknown',
      verdict: 'needs_review',
    })
  })

  it('GTMコンテナ経由と直接設置Googleタグ経由を別の検出方法で保持する', () => {
    const html = `<html><head>${googleTag.code}</head><body></body></html>`
    const result = inspect({
      rawHtml: html,
      renderedHtml: html,
      expected: [googleTag],
      network: [
        {
          url: 'https://www.google-analytics.com/g/collect?tid=G-FROMGTM',
          initiatorUrls: ['https://www.googletagmanager.com/gtm.js?id=GTM-ABC123'],
        },
        {
          url: 'https://www.google-analytics.com/g/collect?tid=G-FROMGT',
          initiatorUrls: ['https://www.googletagmanager.com/gtag/js?id=GT-SITE123'],
        },
      ],
    })

    expect(result.detections.find(item => item.id === 'G-FROMGTM')).toMatchObject({ detectionMethod: 'gtm_delivered', installationMethod: 'gtm' })
    expect(result.detections.find(item => item.id === 'G-FROMGT')).toMatchObject({ detectionMethod: 'google_tag_delivered', installationMethod: 'google_tag' })
  })

  it('Site KitのGTタグから発生したGA4通信を根拠付きで関連付け、期待GT設置は別に評価する', () => {
    const html = `<html><head><!-- Google タグ (gtag.js) スニペット (Site Kit が追加) -->${googleTag.code}</head><body></body></html>`
    const result = inspect({
      rawHtml: html,
      renderedHtml: html,
      expected: [googleTag],
      network: [{
        url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-SITEKIT1&en=page_view',
        initiatorUrls: ['https://www.googletagmanager.com/gtag/js?id=GT-SITE123'],
      }],
    })

    expect(result.finding.verdict).toBe('ok')
    expect(result.detections.find(item => item.id === 'GT-SITE123')).toMatchObject({ detectionMethod: 'html_direct', verdict: 'ok' })
    expect(result.detections.find(item => item.id === 'G-SITEKIT1')).toMatchObject({
      detectionMethod: 'google_tag_delivered',
      sourceTagId: 'GT-SITE123',
      verdict: 'ok',
    })
  })

  it('関連付け先GTが期待未登録なら、GA4経路が判明しても直接設置GTをNGにする', () => {
    const html = `<html><head>${googleTag.code}</head><body></body></html>`
    const result = inspect({
      rawHtml: html,
      renderedHtml: html,
      network: [{
        url: 'https://www.google-analytics.com/g/collect?tid=G-GA123',
        initiatorUrls: ['https://www.googletagmanager.com/gtag/js?id=GT-SITE123'],
      }],
    })

    expect(result.finding.verdict).toBe('ng')
    expect(result.detections.find(item => item.id === 'GT-SITE123')).toMatchObject({ verdict: 'ng' })
    expect(result.detections.find(item => item.id === 'G-GA123')).toMatchObject({ verdict: 'ok', sourceTagId: 'GT-SITE123' })
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

  it('長い通信URLは秘密パラメーターをマスクしつつ完全な根拠を保持する', () => {
    const tail = 'x'.repeat(3_000)
    const result = inspect({
      network: [{
        url: `https://www.google-analytics.com/g/collect?tid=G-LONG1&en=page_view&token=secret&payload=${tail}`,
        initiatorUrls: [],
      }],
    })
    const evidence = result.detections[0]?.evidence[0] ?? ''

    expect(evidence).toContain('token=%5BREDACTED%5D')
    expect(evidence).not.toContain('token=secret')
    expect(evidence.endsWith(tail)).toBe(true)
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
