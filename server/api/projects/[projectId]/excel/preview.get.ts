import { toApiError } from '~/server/services/api-errors'
import { readExcelInput } from '~/server/services/excel-input'
import { useProjectStore } from '~/server/services/project-store'
import { requireProjectId } from '~/server/services/request'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const store = useProjectStore()
  try {
    const project = await store.get(projectId)
    if (!project.excelFileName) {
      throw createError({ statusCode: 409, statusMessage: 'Excelファイルが登録されていません' })
    }
    return {
      preview: await readExcelInput(store.excelPath(projectId), project.excelFileName),
    }
  } catch (error) {
    return toApiError(error)
  }
})
