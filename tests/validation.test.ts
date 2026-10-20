import { describe, expect, it } from 'vitest'
import { defaultProjectSettings } from '~/shared/types/project'
import { projectMutationSchema } from '~/server/services/validation'

describe('案件入力検証', () => {
  it('既定設定を受理する', () => {
    expect(projectMutationSchema.safeParse({ name: '案件A', settings: defaultProjectSettings() }).success).toBe(true)
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
})
