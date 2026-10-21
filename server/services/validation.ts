import { z } from 'zod'

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
  }).default({ mode: 'off' }),
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
  if (value.settings.ai.mode === 'api') {
    context.addIssue({
      code: 'custom',
      path: ['settings', 'ai', 'mode'],
      message: 'OpenAI APIによる自動判定はPhase 5-Cまで利用できません',
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
