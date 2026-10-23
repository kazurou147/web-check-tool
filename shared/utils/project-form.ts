import type {
  ProjectMutationInput,
  ProjectSettings,
  ProjectView,
} from '~/shared/types/project'
import { defaultProjectSettings } from '~/shared/types/project'

export interface ProjectFormState {
  name: string
  settings: ProjectSettings
  username: string
  password: string
}

export function createProjectFormState(project?: ProjectView): ProjectFormState {
  return {
    name: project?.name ?? '',
    settings: copyProjectSettings(project?.settings ?? defaultProjectSettings()),
    username: '',
    password: '',
  }
}

export function buildProjectMutationInput(form: ProjectFormState): ProjectMutationInput {
  const mode = form.settings.auth.mode
  const payload: ProjectMutationInput = {
    name: form.name,
    settings: copyProjectSettings(form.settings),
  }

  if (mode !== 'none' && form.username && form.password) {
    payload.secrets = {
      [mode]: {
        username: form.username,
        password: form.password,
      },
    }
  }

  return payload
}

function copyProjectSettings(settings: ProjectSettings): ProjectSettings {
  return {
    pageConcurrency: settings.pageConcurrency,
    navigationTimeoutMs: settings.navigationTimeoutMs,
    allowedPrivateHosts: [...(settings.allowedPrivateHosts ?? [])],
    ai: {
      mode: settings.ai?.mode ?? 'off',
      model: settings.ai?.model ?? defaultProjectSettings().ai.model,
      priceProfileId: settings.ai?.priceProfileId ?? defaultProjectSettings().ai.priceProfileId,
      costLimitUsd: settings.ai?.costLimitUsd ?? defaultProjectSettings().ai.costLimitUsd,
    },
    auth: {
      mode: settings.auth.mode,
      loginUrl: settings.auth.loginUrl,
      usernameSelector: settings.auth.usernameSelector,
      passwordSelector: settings.auth.passwordSelector,
      submitSelector: settings.auth.submitSelector,
      successUrlPattern: settings.auth.successUrlPattern,
    },
  }
}
