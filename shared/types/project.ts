import type { AiMode } from './ai'

export type AuthMode = 'none' | 'basic' | 'form'

export interface ProjectSettings {
  pageConcurrency: 1 | 2 | 3
  navigationTimeoutMs: number
  allowedPrivateHosts: string[]
  ai: {
    mode: AiMode
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

export interface ProjectSecrets {
  basic?: { username: string; password: string }
  form?: { username: string; password: string }
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
