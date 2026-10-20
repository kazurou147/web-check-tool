import { describe, expect, it } from 'vitest'
import { checkImages } from '~/server/services/checks/images'
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

  it('lazy loadingのため段階スクロールし、待機を2秒以下に制限する', async () => {
    let y = 0
    let now = 0
    const waits: number[] = []
    const timedOut = await performProgressiveScroll({
      state: async () => ({ y, height: 2_000, viewport: 500 }),
      scrollBy: async step => { y += step },
      wait: async milliseconds => { waits.push(milliseconds); now += milliseconds },
    }, 60_000, 5_000, () => now)

    expect(timedOut).toBe(false)
    expect(y).toBeGreaterThanOrEqual(1_500)
    expect(Math.max(...waits)).toBe(2_000)
  })

  it('端末別の時間上限でスクロールを停止する', async () => {
    let now = 0
    const timedOut = await performProgressiveScroll({
      state: async () => ({ y: 0, height: 10_000, viewport: 500 }),
      scrollBy: async () => undefined,
      wait: async milliseconds => { now += milliseconds },
    }, 3_000, 2_000, () => now)

    expect(timedOut).toBe(true)
    expect(now).toBe(3_000)
  })
})
