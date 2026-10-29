import { toApiError } from '~/server/services/api-errors'
import { ArchivedProjectError, useProjectStore } from '~/server/services/project-store'
import { readValidatedBody, requireProjectId } from '~/server/services/request'
import { parseEncryptionKey } from '~/server/services/secret-vault'
import { projectMutationSchema } from '~/server/services/validation'
import { hydrateProjectAuthUrls, mergeProjectSecrets, prepareProjectSettingsUpdate, protectProjectAuthUrls } from '~/server/services/project-url-security'
import type { ProjectSecrets } from '~/shared/types/project'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const input = await readValidatedBody(event, projectMutationSchema)
  const store = useProjectStore()
  try {
    const current = await store.get(projectId)
    const mode = input.settings.auth.mode
    if (mode === 'form' && current.settings.auth.mode !== 'form') {
      throw createError({ statusCode: 400, statusMessage: '旧フォーム認証は新規設定できません。認証方式を再選択してください' })
    }
    if (mode === 'password_protected' && !input.secrets?.password_protected && !await store.passwordProtectedSecrets.exists(projectId)) {
      throw createError({ statusCode: 400, statusMessage: 'パスワード保護のパスワードが必要です' })
    }
    const usesEncryptedSecrets = mode === 'basic' || mode === 'form'
    const storedSecrets: ProjectSecrets = usesEncryptedSecrets && await store.vault.exists(projectId)
      ? await store.vault.read(projectId)
      : {}
    if (usesEncryptedSecrets && !input.secrets?.[mode] && !storedSecrets[mode]) {
      throw createError({ statusCode: 400, statusMessage: '選択した認証方式のユーザー名とパスワードが必要です' })
    }
    const currentSettings = hydrateProjectAuthUrls(current.settings, storedSecrets)
    const submittedSettings = prepareProjectSettingsUpdate(currentSettings, input.settings)
    const submittedEncryptedSecrets: ProjectSecrets = {
      ...(input.secrets?.basic ? { basic: input.secrets.basic } : {}),
      ...(input.secrets?.form ? { form: input.secrets.form } : {}),
    }
    const protectedInput = protectProjectAuthUrls(submittedSettings, mergeProjectSecrets(storedSecrets, submittedEncryptedSecrets))
    if (Object.keys(protectedInput.secrets).length) parseEncryptionKey(process.env.APP_ENCRYPTION_KEY)
    if (current.archivedAt) throw new ArchivedProjectError('アーカイブ中の案件は編集できません')
    const project = await store.update(projectId, { name: input.name, settings: protectedInput.settings })
    if (Object.keys(protectedInput.secrets).length) await store.vault.write(projectId, protectedInput.secrets)
    if (mode === 'password_protected') {
      if (input.secrets?.password_protected) {
        await store.passwordProtectedSecrets.write(projectId, input.secrets.password_protected.password)
      }
    } else {
      await store.passwordProtectedSecrets.delete(projectId)
    }
    return { project: await store.view(project) }
  } catch (error) {
    return toApiError(error)
  }
})
