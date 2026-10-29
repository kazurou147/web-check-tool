import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SECURITY_ERROR_CODES } from '~/shared/security/security-constants'
import type { InputSnapshot } from '~/shared/types/excel-input'
import type { RunResult } from '~/shared/types/run'
import { validateLocalApiRequest } from '~/server/services/local-api-security'
import { secureRunForPublic } from '~/server/services/persistence-security'
import { RunStore } from '~/server/services/run-store'
import { defaultProjectSettings, type Project } from '~/shared/types/project'
import { hydrateProjectAuthUrls, prepareProjectSettingsUpdate, protectProjectAuthUrls, publicProjectView } from '~/server/services/project-url-security'
import {
  initializeUrlIdentityKey,
  URL_IDENTITY_KEY_FILE,
} from '~/server/services/url-identity'

const projectId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Security-B localhost API保護', () => {
  const valid = {
    method: 'POST',
    path: `/api/projects/${projectId}/runs`,
    host: '127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
    fetchSite: 'same-origin',
    csrfToken: 'valid',
  }
  const verify = (value: string | undefined) => value === 'valid'

  it('同一Origin・正しいCSRFの通常変更操作を許可する', () => {
    expect(validateLocalApiRequest(valid, verify)).toBeUndefined()
  })

  it.each([
    [{ ...valid, host: 'localhost:3000' }, SECURITY_ERROR_CODES.requestHostRejected],
    [{ ...valid, host: 'evil.example' }, SECURITY_ERROR_CODES.requestHostRejected],
    [{ ...valid, origin: 'https://evil.example' }, SECURITY_ERROR_CODES.requestOriginRejected],
    [{ ...valid, origin: undefined }, SECURITY_ERROR_CODES.requestOriginRejected],
    [{ ...valid, fetchSite: 'cross-site' }, SECURITY_ERROR_CODES.fetchMetadataRejected],
    [{ ...valid, csrfToken: 'invalid' }, SECURITY_ERROR_CODES.csrfRejected],
  ])('不正なHost・Origin・Fetch Metadata・CSRFを拒否する', (request, code) => {
    expect(validateLocalApiRequest(request, verify)?.code).toBe(code)
  })

  it('API用途ごとのContent-Typeを制限する', () => {
    expect(validateLocalApiRequest({
      ...valid,
      path: '/api/projects',
      contentType: 'text/plain',
      contentLength: '2',
    }, verify)?.statusCode).toBe(415)
    expect(validateLocalApiRequest({
      ...valid,
      path: `/api/projects/${projectId}/excel`,
      contentType: 'application/json',
      contentLength: '2',
    }, verify)?.statusCode).toBe(415)
    expect(validateLocalApiRequest({
      ...valid,
      path: `/api/projects/${projectId}/excel`,
      contentType: 'multipart/form-data; boundary=fixture',
      contentLength: '100',
    }, verify)).toBeUndefined()
  })

  it('GETは同一Hostで利用でき、クロスOriginは拒否する', () => {
    expect(validateLocalApiRequest({ method: 'GET', path: '/api/security/csrf', host: '127.0.0.1:3000' }, verify)).toBeUndefined()
    expect(validateLocalApiRequest({ method: 'GET', path: '/api/security/csrf', host: '127.0.0.1:3000', origin: 'https://evil.example' }, verify)?.code)
      .toBe(SECURITY_ERROR_CODES.requestOriginRejected)
  })
})

describe('Security-C URL秘密情報保護', () => {
  it('旧フォーム認証URLは表示時だけマスクし、変更されなければ内部設定を維持する', () => {
    const settings = defaultProjectSettings()
    settings.auth = {
      mode: 'form',
      loginUrl: 'https://example.com/login?token=legacy-login-secret',
      usernameSelector: '#user',
      passwordSelector: '#password',
      submitSelector: 'button',
      successUrlPattern: '/account?session=legacy-session',
    }
    const project: Project = {
      schemaVersion: 1,
      projectId,
      name: '認証fixture',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      archivedAt: null,
      excelFileName: '',
      settings,
    }
    const view = publicProjectView(project, true)
    expect(JSON.stringify(view)).not.toContain('legacy-login-secret')
    expect(JSON.stringify(view)).not.toContain('legacy-session')
    const preserved = prepareProjectSettingsUpdate(settings, view.settings)
    expect(preserved.auth.loginUrl).toBe(settings.auth.loginUrl)
    expect(preserved.auth.successUrlPattern).toBe(settings.auth.successUrlPattern)
    const protectedData = protectProjectAuthUrls(settings, { form: { username: 'user', password: 'password' } })
    expect(JSON.stringify(protectedData.settings)).not.toContain('legacy-login-secret')
    expect(protectedData.secrets.protectedUrls?.loginUrl).toBe(settings.auth.loginUrl)
    expect(hydrateProjectAuthUrls(protectedData.settings, protectedData.secrets)).toEqual(settings)
  })

  it('新規runの正本JSONとeventsへ秘密値を保存せず、秘密値違いをHMACで区別する', async () => {
    const dataDir = await mkdtemp(join(process.cwd(), '.test-data-security-c-'))
    temporaryDirectories.push(dataDir)
    const store = new RunStore(join(dataDir, 'projects'))
    const first = 'https://user:pass@example.com/page?token=alpha-secret&safe=1'
    const second = 'https://example.com/page?token=beta-secret&safe=1'
    const input = fixtureInput(first, second)
    const result = fixtureResult(input)
    await mkdir(join(dataDir, 'projects', projectId, 'runs'), { recursive: true })
    await store.create(projectId, runId, input, result)
    await store.appendEvent(projectId, runId, { at: new Date(0).toISOString(), type: 'page_completed', url: first })

    const snapshotText = await readFile(join(store.runDir(projectId, runId), 'input-snapshot.json'), 'utf8')
    const resultText = await readFile(join(store.runDir(projectId, runId), 'result.json'), 'utf8')
    const eventsText = await readFile(join(store.runDir(projectId, runId), 'events.jsonl'), 'utf8')
    for (const text of [snapshotText, resultText, eventsText]) {
      expect(text).not.toContain('alpha-secret')
      expect(text).not.toContain('beta-secret')
      expect(text).not.toContain('user:pass')
      expect(text).not.toContain('link-secret')
      expect(text).not.toContain('image-secret')
      expect(text).not.toContain('tag-secret')
    }
    const saved = await store.get(projectId, runId)
    expect(saved.input.pageRows[0]?.url).toContain('%5BREDACTED%5D')
    expect(saved.input.pageRows[0]?.urlIdentity).toMatch(/^url-hmac-v1:/)
    expect(saved.input.pageRows[0]?.urlIdentity).not.toBe(saved.input.pageRows[1]?.urlIdentity)
    expect(saved.pages[0]?.urlIdentity).toBe(saved.input.pageRows[0]?.urlIdentity)
    expect(saved.links[0]?.targetUrlIdentity).toMatch(/^url-hmac-v1:/)
    expect(saved.links[0]?.finalUrlIdentity).toMatch(/^url-hmac-v1:/)
    expect(saved.images[0]?.imageUrlIdentity).toMatch(/^url-hmac-v1:/)
    expect(input.pageRows[0]?.url).toBe(first)
  })

  it('旧履歴はディスクを変更せずAPI表示用コピーだけを安全化する', () => {
    const input = fixtureInput('https://example.com/?access_token=legacy-secret', 'https://example.com/other')
    const legacy = fixtureResult(input)
    const imageUrl = 'https://dcmh.test-kazurou147.biz/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.webp?width=1200&token=image-legacy-secret'
    legacy.images[0]!.imageUrl = imageUrl
    legacy.pages[0]!.findings[0]!.evidence = [`desktop ${imageUrl}: 画像の通信エラーを確認しました。`]
    legacy.fatalError = { code: 'FIXTURE', message: 'request https://example.com/?key=hidden-value failed', retryable: false }
    const before = JSON.stringify(legacy)
    const publicResult = secureRunForPublic(legacy)
    expect(JSON.stringify(publicResult)).not.toContain('legacy-secret')
    expect(JSON.stringify(publicResult)).not.toContain('hidden-value')
    expect(publicResult.images[0]?.imageUrl).toContain('/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.webp')
    expect(publicResult.pages[0]?.findings[0]?.evidence?.[0]).toContain('/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.webp')
    expect(JSON.stringify(publicResult)).not.toContain('[MASKED_HIGH_ENTROPY]')
    expect(JSON.stringify(legacy)).toBe(before)
  })

  it('初期化済み鍵が欠落した場合は黙って再生成しない', async () => {
    const dataDir = await mkdtemp(join(process.cwd(), '.test-data-security-key-'))
    temporaryDirectories.push(dataDir)
    await initializeUrlIdentityKey(dataDir)
    await unlink(join(dataDir, URL_IDENTITY_KEY_FILE))
    await expect(initializeUrlIdentityKey(dataDir)).rejects.toMatchObject({
      code: SECURITY_ERROR_CODES.urlIdentityKeyMissing,
    })
  })
})

function fixtureInput(first: string, second: string): InputSnapshot {
  const rows = [first, second].map((url, index) => ({
    sourceRow: index + 2,
    pageName: null,
    displayName: url,
    url,
    normalizedUrl: url,
    expectedTitle: null,
    expectedDescription: null,
    titleState: 'blank' as const,
    descriptionState: 'blank' as const,
  }))
  return {
    schemaVersion: 1,
    sourceFileName: 'fixture.xlsx',
    sheetName: '納品前のチェック',
    tagSheetName: 'Googleタグ',
    canStart: true,
    totalDataRows: 2,
    blankRows: 0,
    hiddenExcludedRows: 0,
    validRows: 2,
    uniqueUrlCount: 2,
    pageRows: rows,
    invalidRows: [],
    headerIssues: [],
    formulaIssues: [],
    mergeIssues: [],
    tagIssues: [],
    duplicateGroups: [],
    expectedGoogleTags: [],
  }
}

function fixtureResult(input: InputSnapshot): RunResult {
  const pageUrl = input.pageRows[0]!.normalizedUrl
  return {
    schemaVersion: 1,
    projectId,
    runId,
    status: 'completed',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    configSnapshot: {
      pageConcurrency: 1,
      navigationTimeoutMs: 30_000,
      retryCount: 2,
      maxRedirects: 10,
      maxResponseBytes: 10_000,
      linkTimeoutMs: 15_000,
      imageTimeoutMsPerDevice: 60_000,
      imageScrollWaitMs: 1_000,
      authMode: 'none',
      allowedPrivateHosts: [],
      aiMode: 'off',
      viewports: { desktop: { width: 1366, height: 768 }, mobile: { width: 375, height: 667 } },
    },
    input,
    summary: { ng: 0, needsReview: 0, unchecked: 0, excluded: 0, ok: 0 },
    pages: [{
      normalizedUrl: pageUrl,
      requestedUrl: pageUrl,
      finalUrl: `${pageUrl}&session=redirect-secret`,
      pageNames: [pageUrl],
      sourceRows: [2],
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      attempts: 1,
      findings: [{
        key: `${pageUrl}|page_fetch`, item: 'page_fetch', verdict: 'ok', detailStatus: 'fetched', url: pageUrl,
        pageNames: [pageUrl], sourceRows: [2], message: 'ok', evidence: [`最終URL: ${pageUrl}`],
      }],
    }],
    links: [{
      key: `${pageUrl}|link|0`, pageUrl, href: 'https://target.example/?key=link-secret',
      resolvedUrl: 'https://target.example/?key=link-secret', finalUrl: 'https://target.example/final?sid=redirect-link-secret',
      kind: 'http', verdict: 'ok', redirectCount: 1, isImageLink: false, message: 'ok',
      evidence: ['https://target.example/?key=link-secret'],
    }],
    images: [{
      key: `${pageUrl}|image|mobile|0`, pageUrl, device: 'mobile',
      imageUrl: 'https://cdn.example/image.png?access_token=image-secret', sourceKind: 'img', location: 'img',
      verdict: 'ok', message: 'ok', evidence: ['https://cdn.example/image.png?access_token=image-secret'],
    }],
    googleTagDetections: [{
      key: `${pageUrl}|G-TEST|network`, pageUrl, id: 'G-TEST', tagType: 'ga4', detectionMethod: 'network',
      installationMethod: 'unknown', evidence: ['https://google.example/collect?token=tag-secret'], verdict: 'needs_review',
      verdictReason: 'fixture', relatedDetectionKeys: [], occurrences: 1,
    }],
    aiUsage: { enabled: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, costLimitUsd: 1, stoppedByCostLimit: false, apiFailureCount: 0 },
  }
}
