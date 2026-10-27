import { describe, expect, it } from 'vitest'
import { checkImages, type CapturedImage, type ImageVisibilityObservation } from '~/server/services/checks/images'
import { performProgressiveScroll } from '~/server/services/playwright-inspector'

describe('画像検査', () => {
  it.each(['desktop', 'mobile'] as const)('%sで通信失敗、表示失敗、未完了、正常を区別する', (device) => {
    const results = checkImages('https://example.com/', device, [
      { imageUrl: 'https://example.com/network.png', sourceKind: 'img', location: 'img.one', complete: false, naturalWidth: 0, decoded: null, networkError: 'HTTP 404' },
      { imageUrl: 'data:image/png;base64,broken', sourceKind: 'img', location: 'img.two', complete: true, naturalWidth: 0, decoded: false },
      { imageUrl: 'https://example.com/lazy.png', sourceKind: 'srcset', location: 'picture img', complete: false, naturalWidth: 0, decoded: null },
      { imageUrl: 'https://example.com/ok.png', sourceKind: 'css_background', location: 'div.hero', complete: true, naturalWidth: 640, decoded: true },
    ], true)

    expect(results.map(item => item.verdict)).toEqual(['ng', 'ng', 'needs_review', 'ok'])
    expect(results.every(item => item.device === device)).toBe(true)
  })

  it('DOM抽出上限を超えた画像URLはNGと断定せず要確認にする', () => {
    const result = checkImages('https://example.com/', 'desktop', [{
      ...baseImage('data:image/png;base64,truncated'),
      captureError: '画像URLが安全な抽出上限を超えたため未確認です。',
    }], false)[0]!
    expect(result).toMatchObject({ verdict: 'needs_review', message: '画像URLが安全な抽出上限を超えたため未確認です。' })
  })

  it('レスポンシブCSSで非表示のlazy画像を十分な根拠がある場合だけ対象外にする', () => {
    const result = checkImages('https://example.com/', 'mobile', [{
      ...baseImage('https://example.com/sidebar.webp'),
      visibility: responsiveHiddenVisibility(),
    }], false)[0]!

    expect(result).toMatchObject({
      verdict: 'excluded',
      exclusion: {
        hiddenBy: 'aside.sidebar',
        cssSelector: '.no-mobile-sidebar .sidebar',
        mediaCondition: 'screen and (max-width: 1023px)',
      },
    })
    expect(result.message).toContain('スマートフォンではレスポンシブCSS')
    expect(result.evidence).toContain('非表示要素: aside.sidebar')
  })

  it('同じ画像をPCではOK、mobileでは対象外として端末別に扱う', () => {
    const desktop = checkImages('https://example.com/', 'desktop', [{
      ...baseImage('https://example.com/sidebar.webp'),
      currentSrc: 'https://example.com/sidebar.webp',
      complete: true,
      naturalWidth: 240,
      naturalHeight: 180,
      decoded: true,
      visibility: { clientRectCount: 1, layoutWidth: 120, layoutHeight: 90, interactiveRisk: false, interactiveEvidence: [] },
    }], false)[0]!
    const mobile = checkImages('https://example.com/', 'mobile', [{
      ...baseImage('https://example.com/sidebar.webp'),
      visibility: responsiveHiddenVisibility(),
    }], false)[0]!

    expect(desktop.verdict).toBe('ok')
    expect(mobile.verdict).toBe('excluded')
  })

  it.each([
    ['アコーディオン', 'details.accordion'],
    ['モーダル', 'div.modal'],
    ['モバイルメニュー', 'nav.mobile-menu'],
  ])('%s内の非表示画像を対象外にしない', (_label, evidence) => {
    const visibility = responsiveHiddenVisibility({
      interactiveRisk: true,
      interactiveEvidence: [`操作で表示される可能性がある要素: ${evidence}`],
    })
    const result = checkImages('https://example.com/', 'mobile', [{
      ...baseImage(`https://example.com/${encodeURIComponent(evidence)}.webp`),
      visibility,
    }], false)[0]!

    expect(result.verdict).toBe('needs_review')
    expect(result.evidence).toContain(`操作で表示される可能性がある要素: ${evidence}`)
  })

  it('非表示理由がmedia queryまで確認できない場合は要確認を維持する', () => {
    const visibility = responsiveHiddenVisibility()
    delete visibility.responsiveRule
    const result = checkImages('https://example.com/', 'mobile', [{
      ...baseImage('https://example.com/unknown.webp'),
      visibility,
    }], false)[0]!

    expect(result.verdict).toBe('needs_review')
  })

  it('対象外候補でも画像のHTTPエラーをNGとして優先する', () => {
    const result = checkImages('https://example.com/', 'mobile', [{
      ...baseImage('https://example.com/broken.webp'),
      visibility: responsiveHiddenVisibility(),
      networkError: 'HTTP 404',
    }], false)[0]!

    expect(result.verdict).toBe('ng')
    expect(result.exclusion).toBeUndefined()
  })

  it('lazy loadingのため0.8 viewportずつ段階スクロールし、待機を1秒以下に制限する', async () => {
    let y = 0
    let now = 0
    const waits: number[] = []
    const diagnostics = await performProgressiveScroll({
      state: async () => ({ y, height: 2_000, viewport: 500 }),
      scrollBy: async step => { y += step },
      wait: async milliseconds => { waits.push(milliseconds); now += milliseconds },
    }, 60_000, 5_000, () => now)

    expect(diagnostics.stopReason).toBe('bottom_stable')
    expect(diagnostics.reachedStableBottom).toBe(true)
    expect(y).toBeGreaterThanOrEqual(1_500)
    expect(Math.max(...waits)).toBe(1_000)
  })

  it('端末別の時間上限でスクロールを停止する', async () => {
    let now = 0
    let y = 0
    const diagnostics = await performProgressiveScroll({
      state: async () => ({ y, height: 10_000, viewport: 500 }),
      scrollBy: async step => { y += step },
      wait: async milliseconds => { now += milliseconds },
    }, 3_000, 2_000, () => now)

    expect(diagnostics.stopReason).toBe('time_limit')
    expect(now).toBe(3_000)
  })

  it('最大60回で停止し、未到達領域があることを診断値へ残す', async () => {
    let y = 0
    let now = 0
    const diagnostics = await performProgressiveScroll({
      state: async () => ({ y, height: 100_000, viewport: 500 }),
      scrollBy: async step => { y += step },
      wait: async milliseconds => { now += milliseconds },
    }, 60_000, 10, () => now)

    expect(diagnostics).toMatchObject({ stopReason: 'scroll_limit', scrollCount: 60, reachedStableBottom: false })
  })

  it('3回連続で進捗がなければ停止する', async () => {
    let now = 0
    const diagnostics = await performProgressiveScroll({
      state: async () => ({ y: 0, height: 10_000, viewport: 500 }),
      scrollBy: async () => undefined,
      wait: async milliseconds => { now += milliseconds },
    }, 60_000, 10, () => now)

    expect(diagnostics).toMatchObject({ stopReason: 'no_progress', scrollCount: 3, noProgressCount: 3 })
  })

  it('AbortSignalを各反復で確認して停止理由を記録する', async () => {
    const controller = new AbortController()
    let y = 0
    const diagnostics = await performProgressiveScroll({
      state: async () => ({ y, height: 10_000, viewport: 500 }),
      scrollBy: async step => { y += step; controller.abort() },
      wait: async () => undefined,
    }, 60_000, 1_000, () => 0, controller.signal)

    expect(diagnostics).toMatchObject({ stopReason: 'aborted', scrollCount: 1, reachedStableBottom: false })
  })
})

function baseImage(imageUrl: string): CapturedImage {
  return {
    imageUrl,
    sourceKind: 'srcset',
    location: 'aside.sidebar img',
    currentSrc: '',
    complete: false,
    naturalWidth: 0,
    naturalHeight: 0,
    decoded: null,
  }
}

function responsiveHiddenVisibility(
  overrides: Partial<ImageVisibilityObservation> = {},
): ImageVisibilityObservation {
  return {
    clientRectCount: 0,
    layoutWidth: 0,
    layoutHeight: 0,
    hiddenAncestor: 'aside.sidebar',
    hiddenProperty: 'display',
    hiddenValue: 'none',
    responsiveRule: {
      selector: '.no-mobile-sidebar .sidebar',
      mediaCondition: 'screen and (max-width: 1023px)',
      stylesheet: 'https://example.com/style.css',
    },
    interactiveRisk: false,
    interactiveEvidence: [],
    ...overrides,
  }
}
