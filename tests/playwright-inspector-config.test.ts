import { describe, expect, it } from 'vitest'
import { createMobileContextOptions, mobileEmulationSnapshot } from '~/server/services/playwright-inspector'
import { createRunConfig } from '~/server/services/run-engine'
import { defaultProjectSettings } from '~/shared/types/project'

describe('Playwright端末別検査設定', () => {
  it('Pixel 5を基準にviewportとscreenだけを375x667へ上書きする', () => {
    const snapshot = mobileEmulationSnapshot()

    expect(snapshot).toMatchObject({
      deviceProfile: 'Pixel 5',
      viewport: { width: 375, height: 667 },
      screen: { width: 375, height: 667 },
      deviceScaleFactor: 2.75,
      isMobile: true,
      hasTouch: true,
    })
    expect(snapshot.userAgent).toMatch(/Android.*Mobile/i)
  })

  it('モバイル用BrowserContextへBasic認証とメモリ上のフォーム認証状態を引き継げる', () => {
    const config = createRunConfig(defaultProjectSettings())
    const storageState = {
      cookies: [{
        name: 'session',
        value: 'masked-test-value',
        domain: 'example.com',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax' as const,
      }],
      origins: [],
    }
    const options = createMobileContextOptions(config, { username: 'user', password: 'pass' }, storageState)

    expect(options).toMatchObject({
      httpCredentials: { username: 'user', password: 'pass' },
      storageState,
      viewport: { width: 375, height: 667 },
      screen: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block',
    })
    expect(typeof options.storageState).not.toBe('string')
  })

  it('run設定スナップショットへ端末条件とlazy loading停止条件を保存する', () => {
    const config = createRunConfig(defaultProjectSettings())

    expect(config).toMatchObject({
      imageTimeoutMsPerDevice: 60_000,
      imageScrollWaitMs: 1_000,
      imageScrollStepViewportRatio: 0.8,
      imageScrollMaxCount: 60,
      imageScrollBottomStableCount: 2,
      imageScrollNoProgressCount: 3,
      mobileEmulation: {
        deviceProfile: 'Pixel 5',
        viewport: { width: 375, height: 667 },
        screen: { width: 375, height: 667 },
        isMobile: true,
        hasTouch: true,
      },
    })
  })
})
