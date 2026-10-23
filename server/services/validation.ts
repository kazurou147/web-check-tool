import { z } from 'zod'
import { DEFAULT_AI_MODEL, DEFAULT_AI_PRICE_PROFILE_ID, findMatchingAiPriceProfile } from '~/shared/config/ai-pricing'

const authSettingsSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('none'),
    loginUrl: z.string().max(2_048).default(''),
    usernameSelector: z.string().max(500).default(''),
    passwordSelector: z.string().max(500).default(''),
    submitSelector: z.string().max(500).default(''),
    successUrlPattern: z.string().max(2_048).default(''),
  }),
  z.object({
    mode: z.literal('basic'),
    loginUrl: z.string().max(2_048).default(''),
    usernameSelector: z.string().max(500).default(''),
    passwordSelector: z.string().max(500).default(''),
    submitSelector: z.string().max(500).default(''),
    successUrlPattern: z.string().max(2_048).default(''),
  }),
  z.object({
    mode: z.literal('form'),
    loginUrl: z.url().max(2_048),
    usernameSelector: z.string().min(1).max(500),
    passwordSelector: z.string().min(1).max(500),
    submitSelector: z.string().min(1).max(500),
    successUrlPattern: z.string().max(2_048).default(''),
  }),
])

export const projectSettingsSchema = z.object({
  pageConcurrency: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  navigationTimeoutMs: z.number().int().min(1_000).max(120_000),
  ai: z.object({
    mode: z.enum(['off', 'manual', 'api']),
    model: z.string().min(1).max(100).default(DEFAULT_AI_MODEL),
    priceProfileId: z.string().min(1).max(200).default(DEFAULT_AI_PRICE_PROFILE_ID),
    costLimitUsd: z.number().finite().min(0.01).max(1_000).default(1),
  }).default({ mode: 'off', model: DEFAULT_AI_MODEL, priceProfileId: DEFAULT_AI_PRICE_PROFILE_ID, costLimitUsd: 1 }),
  allowedPrivateHosts: z.array(z.string().trim().min(1).max(253)
    .regex(/^(?:\[[0-9a-f:]+\]|[0-9a-z.-]+)$/i, 'ホスト名だけを入力してください')).max(50).default([]),
  auth: authSettingsSchema,
})

const credentialsSchema = z.object({
  username: z.string().min(1).max(500),
  password: z.string().min(1).max(2_000),
})

export const projectMutationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  settings: projectSettingsSchema,
  secrets: z.object({
    basic: credentialsSchema.optional(),
    form: credentialsSchema.optional(),
  }).optional(),
}).superRefine((value, context) => {
  if (value.settings.ai.mode === 'api' && !findMatchingAiPriceProfile(value.settings.ai.priceProfileId, value.settings.ai.model)) {
    context.addIssue({
      code: 'custom',
      path: ['settings', 'ai', 'priceProfileId'],
      message: '選択したモデルに対応する料金プロファイルがありません',
    })
  }
  const mode = value.settings.auth.mode
  if (mode !== 'none' && value.secrets && !value.secrets[mode]) {
    context.addIssue({
      code: 'custom',
      path: ['secrets', mode],
      message: `${mode}認証のユーザー名とパスワードが必要です`,
    })
  }
})

export const projectIdSchema = z.uuid()
