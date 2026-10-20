import { basename, extname } from 'node:path'
import { toApiError } from '~/server/services/api-errors'
import { useProjectStore } from '~/server/services/project-store'
import { requireProjectId } from '~/server/services/request'

const MAX_EXCEL_BYTES = 20 * 1024 * 1024
const ACCEPTED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  'application/zip',
])

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const parts = await readMultipartFormData(event)
  const file = parts?.find(part => part.name === 'excel' && part.filename)
  if (!file?.filename) throw createError({ statusCode: 400, statusMessage: 'Excelファイルを選択してください' })

  const fileName = basename(file.filename)
  if (extname(fileName).toLowerCase() !== '.xlsx') {
    throw createError({ statusCode: 400, statusMessage: '.xlsxファイルだけ登録できます' })
  }
  if (file.data.byteLength === 0 || file.data.byteLength > MAX_EXCEL_BYTES) {
    throw createError({ statusCode: 400, statusMessage: 'Excelファイルは20MB以下にしてください' })
  }
  if (file.type && !ACCEPTED_MIME_TYPES.has(file.type)) {
    throw createError({ statusCode: 400, statusMessage: 'ExcelファイルのMIMEタイプが不正です' })
  }
  if (file.data[0] !== 0x50 || file.data[1] !== 0x4b) {
    throw createError({ statusCode: 400, statusMessage: '有効な.xlsxファイルではありません' })
  }

  try {
    const store = useProjectStore()
    return { project: await store.view(await store.saveExcel(projectId, fileName, file.data)) }
  } catch (error) {
    return toApiError(error)
  }
})
