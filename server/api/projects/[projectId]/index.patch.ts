import { toApiError } from '~/server/services/api-errors'
import { ArchivedProjectError, useProjectStore } from '~/server/services/project-store'
import { readValidatedBody, requireProjectId } from '~/server/services/request'
import { parseEncryptionKey } from '~/server/services/secret-vault'
import { projectMutationSchema } from '~/server/services/validation'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const input = await readValidatedBody(event, projectMutationSchema)
  const store = useProjectStore()
  try {
    const current = await store.get(projectId)
    const mode = input.settings.auth.mode
    if (mode !== 'none' && !input.secrets?.[mode]) {
      const stored = await store.vault.exists(projectId) ? await store.vault.read(projectId) : {}
      if (!stored[mode]) {
        throw createError({ statusCode: 400, statusMessage: '選択した認証方式のユーザー名とパスワードが必要です' })
      }
    }
    if (input.secrets) parseEncryptionKey(process.env.APP_ENCRYPTION_KEY)
    if (current.archivedAt) throw new ArchivedProjectError('アーカイブ中の案件は編集できません')
    const project = await store.update(projectId, { name: input.name, settings: input.settings })
    if (input.secrets) await store.vault.write(projectId, input.secrets)
    return { project: await store.view(project) }
  } catch (error) {
    return toApiError(error)
  }
})
