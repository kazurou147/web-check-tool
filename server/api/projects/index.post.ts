import { toApiError } from '~/server/services/api-errors'
import { useProjectStore } from '~/server/services/project-store'
import { readValidatedBody } from '~/server/services/request'
import { parseEncryptionKey } from '~/server/services/secret-vault'
import { projectMutationSchema } from '~/server/services/validation'
import { protectProjectAuthUrls } from '~/server/services/project-url-security'

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, projectMutationSchema)
  const store = useProjectStore()
  try {
    const mode = input.settings.auth.mode
    if (mode !== 'none' && !input.secrets?.[mode]) {
      throw createError({ statusCode: 400, statusMessage: '認証を使用する場合はユーザー名とパスワードが必要です' })
    }
    const protectedInput = protectProjectAuthUrls(input.settings, input.secrets ?? {})
    if (Object.keys(protectedInput.secrets).length) parseEncryptionKey(process.env.APP_ENCRYPTION_KEY)
    const project = await store.create(input.name, protectedInput.settings)
    if (Object.keys(protectedInput.secrets).length) await store.vault.write(project.projectId, protectedInput.secrets)
    setResponseStatus(event, 201)
    return { project: await store.view(project) }
  } catch (error) {
    return toApiError(error)
  }
})
