import { toApiError } from '~/server/services/api-errors'
import { readExcelInput } from '~/server/services/excel-input'
import { useProjectStore } from '~/server/services/project-store'
import { requireProjectId } from '~/server/services/request'
import { secureInputSnapshot } from '~/server/services/persistence-security'
import { initializeUrlIdentityKey } from '~/server/services/url-identity'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const store = useProjectStore()
  try {
    const project = await store.get(projectId)
    if (!project.excelFileName) {
      throw createError({ statusCode: 409, statusMessage: 'Excelファイルが登録されていません' })
    }
    const input = await readExcelInput(store.excelPath(projectId), project.excelFileName)
    const identityKey = await initializeUrlIdentityKey(store.dataDir, process.env.APP_ENCRYPTION_KEY)
    return { preview: secureInputSnapshot(input, identityKey) }
  } catch (error) {
    return toApiError(error)
  }
})
