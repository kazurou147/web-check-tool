import { describe, expect, it } from 'vitest'
import { defaultProjectSettings } from '~/shared/types/project'
import { projectMutationSchema } from '~/server/services/validation'

describe('案件入力検証', () => {
  it('既定設定を受理する', () => {
    expect(projectMutationSchema.safeParse({ name: '案件A', settings: defaultProjectSettings() }).success).toBe(true)
  })

  it('AI設定がない旧形式をoffとして受理する', () => {
    const settings = defaultProjectSettings() as Partial<ReturnType<typeof defaultProjectSettings>>
    delete settings.ai
    const parsed = projectMutationSchema.parse({ name: '旧案件', settings })
    expect(parsed.settings.ai).toEqual({ mode: 'off' })
  })

  it('空の案件名と範囲外の並列数を拒否する', () => {
    const settings = { ...defaultProjectSettings(), pageConcurrency: 4 }
    expect(projectMutationSchema.safeParse({ name: ' ', settings }).success).toBe(false)
  })

  it('フォーム認証の必須セレクターを検証する', () => {
    const settings = defaultProjectSettings()
    settings.auth = {
      mode: 'form',
      loginUrl: 'https://example.com/login',
      usernameSelector: '',
      passwordSelector: '#password',
      submitSelector: 'button',
      successUrlPattern: '',
    }
    expect(projectMutationSchema.safeParse({ name: '案件', settings }).success).toBe(false)
  })

  it('MANUALを受理し、未実装のAPIモードを拒否する', () => {
    const manual = defaultProjectSettings()
    manual.ai.mode = 'manual'
    expect(projectMutationSchema.safeParse({ name: '手動判定', settings: manual }).success).toBe(true)
    const api = defaultProjectSettings()
    api.ai.mode = 'api'
    expect(projectMutationSchema.safeParse({ name: 'API判定', settings: api }).success).toBe(false)
  })
})
