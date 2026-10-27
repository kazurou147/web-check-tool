import type { Project, ProjectSecrets, ProjectSettings, ProjectView } from '~/shared/types/project'
import { maskUrlForDisplay } from '~/shared/security/url-security'
import { maskSecretText } from './ai-masking'

export function publicProjectView(project: Project, credentialsConfigured: boolean): ProjectView {
  return {
    ...project,
    settings: {
      ...project.settings,
      ai: { ...project.settings.ai },
      allowedPrivateHosts: [...project.settings.allowedPrivateHosts],
      auth: {
        ...project.settings.auth,
        loginUrl: safeSettingUrl(project.settings.auth.loginUrl),
        successUrlPattern: safeSettingUrl(project.settings.auth.successUrlPattern),
      },
    },
    credentialsConfigured,
  }
}

export function prepareProjectSettingsUpdate(current: ProjectSettings, submitted: ProjectSettings): ProjectSettings {
  const output = structuredClone(submitted)
  for (const field of ['loginUrl', 'successUrlPattern'] as const) {
    const currentValue = current.auth[field]
    if (currentValue && submitted.auth[field] === safeSettingUrl(currentValue)) {
      output.auth[field] = currentValue
    }
  }
  return output
}

export function protectProjectAuthUrls(settings: ProjectSettings, secrets: ProjectSecrets): {
  settings: ProjectSettings
  secrets: ProjectSecrets
} {
  const protectedSettings = structuredClone(settings)
  const protectedSecrets = structuredClone(secrets)
  const protectedUrls: NonNullable<ProjectSecrets['protectedUrls']> = {}
  for (const field of ['loginUrl', 'successUrlPattern'] as const) {
    const value = settings.auth[field]
    const masked = safeSettingUrl(value)
    if (value && masked !== value) {
      protectedSettings.auth[field] = masked
      protectedUrls[field] = value
    }
  }
  if (Object.keys(protectedUrls).length) protectedSecrets.protectedUrls = protectedUrls
  else delete protectedSecrets.protectedUrls
  return { settings: protectedSettings, secrets: protectedSecrets }
}

export function hydrateProjectAuthUrls(settings: ProjectSettings, secrets: ProjectSecrets): ProjectSettings {
  const hydrated = structuredClone(settings)
  if (secrets.protectedUrls?.loginUrl) hydrated.auth.loginUrl = secrets.protectedUrls.loginUrl
  if (secrets.protectedUrls?.successUrlPattern) hydrated.auth.successUrlPattern = secrets.protectedUrls.successUrlPattern
  return hydrated
}

export function mergeProjectSecrets(current: ProjectSecrets, submitted?: ProjectSecrets): ProjectSecrets {
  return {
    ...current,
    ...(submitted?.basic ? { basic: submitted.basic } : {}),
    ...(submitted?.form ? { form: submitted.form } : {}),
    ...(current.protectedUrls ? { protectedUrls: current.protectedUrls } : {}),
  }
}

function safeSettingUrl(value: string): string {
  if (!value) return value
  try {
    return maskUrlForDisplay(value).value
  } catch {
    return maskSecretText(value).value
  }
}
