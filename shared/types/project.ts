import type { AiMode } from './ai'
import type { RunSummary } from './run'
import { DEFAULT_AI_MODEL, DEFAULT_AI_PRICE_PROFILE_ID } from '~/shared/config/ai-pricing'

export type AuthMode = 'none' | 'basic' | 'form'

export interface ProjectSettings {
  pageConcurrency: 1 | 2 | 3
  navigationTimeoutMs: number
  allowedPrivateHosts: string[]
  ai: {
    mode: AiMode
    model: string
    priceProfileId: string
    costLimitUsd: number
  }
  auth: {
    mode: AuthMode
    loginUrl: string
    usernameSelector: string
    passwordSelector: string
    submitSelector: string
    successUrlPattern: string
  }
}

export interface Project {
  schemaVersion: 1
  projectId: string
  name: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  excelFileName: string
  settings: ProjectSettings
}

export interface ProjectView extends Project {
  credentialsConfigured: boolean
}

export interface RunHistoryHealth {
  corruptedCount: number
  oversizedCount: number
}

export interface ProjectListItem extends ProjectView {
  latestRun: RunSummary | null
  latestCompletedRun: RunSummary | null
  historyHealth: RunHistoryHealth
}

export interface ProjectSecrets {
  basic?: { username: string; password: string }
  form?: { username: string; password: string }
  protectedUrls?: { loginUrl?: string; successUrlPattern?: string }
}

export interface ProjectMutationInput {
  name: string
  settings: ProjectSettings
  secrets?: ProjectSecrets
}

export const defaultProjectSettings = (): ProjectSettings => ({
  pageConcurrency: 3,
  navigationTimeoutMs: 30_000,
  allowedPrivateHosts: [],
  ai: {
    mode: 'off',
    model: DEFAULT_AI_MODEL,
    priceProfileId: DEFAULT_AI_PRICE_PROFILE_ID,
    costLimitUsd: 1,
  },
  auth: {
    mode: 'none',
    loginUrl: '',
    usernameSelector: '',
    passwordSelector: '',
    submitSelector: '',
    successUrlPattern: '',
  },
})
