import { toApiError } from '~/server/services/api-errors'
import { useProjectStore } from '~/server/services/project-store'
import { readValidatedBody } from '~/server/services/request'
import { parseEncryptionKey } from '~/server/services/secret-vault'
import { projectMutationSchema } from '~/server/services/validation'
import { protectProjectAuthUrls } from '~/server/services/project-url-security'
import type { ProjectSecrets } from '~/shared/types/project'

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, projectMutationSchema)
  const store = useProjectStore()
  try {
    const mode = input.settings.auth.mode
    if (mode === 'form') {
      throw createError({ statusCode: 400, statusMessage: '旧フォーム認証は新規設定できません。認証方式を再選択してください' })
    }
    if (mode !== 'none' && !input.secrets?.[mode]) {
      throw createError({ statusCode: 400, statusMessage: mode === 'password_protected' ? 'パスワード保護のパスワードが必要です' : 'Basic認証のユーザー名とパスワードが必要です' })
    }
    const encryptedSecrets: ProjectSecrets = mode === 'basic' && input.secrets?.basic
      ? { basic: input.secrets.basic }
      : {}
    const protectedInput = protectProjectAuthUrls(input.settings, encryptedSecrets)
    if (Object.keys(protectedInput.secrets).length) parseEncryptionKey(process.env.APP_ENCRYPTION_KEY)
    const project = await store.create(input.name, protectedInput.settings)
    if (Object.keys(protectedInput.secrets).length) await store.vault.write(project.projectId, protectedInput.secrets)
    if (mode === 'password_protected') {
      await store.passwordProtectedSecrets.write(project.projectId, input.secrets!.password_protected!.password)
    }
    setResponseStatus(event, 201)
    return { project: await store.view(project) }
  } catch (error) {
    return toApiError(error)
  }
})
