import { isProxy, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import type { ProjectView } from '~/shared/types/project'
import { buildProjectMutationInput, createProjectFormState } from '~/shared/utils/project-form'

describe('ProjectFormの送信データ', () => {
  it('案件作成時にリアクティブProxyから必要な値だけをプレーンオブジェクト化する', () => {
    const form = reactive(createProjectFormState())
    form.name = 'コーポレートサイト'
    form.settings.pageConcurrency = 2
    form.settings.navigationTimeoutMs = 45_000
    form.settings.auth.mode = 'basic'
    form.username = 'client-user'
    form.password = 'secret-password'
    Object.assign(form, { unexpectedValue: '送信しない' })

    expect(isProxy(form.settings)).toBe(true)
    expect(() => buildProjectMutationInput(form)).not.toThrow()

    const payload = buildProjectMutationInput(form)
    expect(isProxy(payload.settings)).toBe(false)
    expect(payload).toEqual({
      name: 'コーポレートサイト',
      settings: {
        pageConcurrency: 2,
        navigationTimeoutMs: 45_000,
        allowedPrivateHosts: [],
        ai: {
          mode: 'off',
          model: 'gpt-6-luna',
          priceProfileId: 'gpt-6-luna-standard-2026-10-22',
          costLimitUsd: 1,
        },
        auth: {
          mode: 'basic',
          loginUrl: '',
          usernameSelector: '',
          passwordSelector: '',
          submitSelector: '',
          successUrlPattern: '',
        },
      },
      secrets: {
        basic: {
          username: 'client-user',
          password: 'secret-password',
        },
      },
    })
    expect(payload).not.toHaveProperty('unexpectedValue')
  })

  it('案件編集時にProxyの案件設定を安全に初期化し、空の認証情報を再送しない', () => {
    const project = reactive<ProjectView>({
      schemaVersion: 1,
      projectId: '4a4763c1-cd9e-45c0-af5a-7a03f64cf6d2',
      name: '既存案件',
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
      archivedAt: null,
      excelFileName: 'input.xlsx',
      credentialsConfigured: true,
      settings: {
        pageConcurrency: 3,
        navigationTimeoutMs: 30_000,
        allowedPrivateHosts: [],
        ai: {
          mode: 'off',
          model: 'gpt-6-luna',
          priceProfileId: 'gpt-6-luna-standard-2026-10-22',
          costLimitUsd: 1,
        },
        auth: {
          mode: 'form',
          loginUrl: 'https://example.com/login',
          usernameSelector: '#username',
          passwordSelector: '#password',
          submitSelector: 'button[type="submit"]',
          successUrlPattern: '/dashboard',
        },
      },
    })

    expect(() => createProjectFormState(project)).not.toThrow()
    const form = reactive(createProjectFormState(project))
    form.name = '更新後の案件名'
    form.settings.navigationTimeoutMs = 60_000

    const payload = buildProjectMutationInput(form)
    expect(isProxy(payload.settings)).toBe(false)
    expect(payload.name).toBe('更新後の案件名')
    expect(payload.settings.navigationTimeoutMs).toBe(60_000)
    expect(payload.settings.auth.loginUrl).toBe('https://example.com/login')
    expect(payload).not.toHaveProperty('secrets')
    expect(project.name).toBe('既存案件')
    expect(project.settings.navigationTimeoutMs).toBe(30_000)
  })

  it('パスワード保護ではユーザー名を送らずパスワードだけを送信する', () => {
    const form = reactive(createProjectFormState())
    form.name = 'パスワード保護案件'
    form.settings.auth.mode = 'password_protected'
    form.username = '送信しないユーザー名'
    form.password = 'site-password'

    expect(buildProjectMutationInput(form).secrets).toEqual({
      password_protected: { password: 'site-password' },
    })
  })

  it('旧フォーム認証案件は勝手に変換せず読み込む', () => {
    const project = reactive<ProjectView>({
      schemaVersion: 1,
      projectId: 'b812ed3f-2181-4f74-af45-2bcfa00388fb',
      name: '旧フォーム認証',
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
      archivedAt: null,
      excelFileName: 'input.xlsx',
      credentialsConfigured: true,
      settings: {
        ...createProjectFormState().settings,
        auth: {
          mode: 'form',
          loginUrl: 'https://example.com/login',
          usernameSelector: '#user',
          passwordSelector: '#pass',
          submitSelector: '#submit',
          successUrlPattern: '/protected',
        },
      },
    })

    const payload = buildProjectMutationInput(createProjectFormState(project))
    expect(payload.settings.auth.mode).toBe('form')
    expect(payload.settings.auth.loginUrl).toBe('https://example.com/login')
    expect(payload.secrets).toBeUndefined()
  })
})
