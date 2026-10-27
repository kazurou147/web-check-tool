import { basename, extname } from 'node:path'
import { toApiError } from '~/server/services/api-errors'
import { useProjectStore } from '~/server/services/project-store'
import { requireProjectId } from '~/server/services/request'
import { SECURITY_LIMITS, SecurityFoundationError } from '~/shared/security/security-constants'
import { readLimitedMultipartFormData } from '~/server/services/request-body-limits'
import { validateXlsxArchive, UnsafeExcelArchiveError } from '~/server/services/xlsx-security'

const ACCEPTED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  'application/zip',
])

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  let parts
  try {
    parts = await readLimitedMultipartFormData(event, SECURITY_LIMITS.excelUploadBytes)
  } catch (error) {
    if (error instanceof SecurityFoundationError) throw createError({ statusCode: 413, statusMessage: error.message, data: { code: error.code } })
    throw error
  }
  const file = parts?.find(part => part.name === 'excel' && part.filename)
  if (!file?.filename) throw createError({ statusCode: 400, statusMessage: 'Excelファイルを選択してください' })

  const fileName = basename(file.filename)
  if (extname(fileName).toLowerCase() !== '.xlsx') {
    throw createError({ statusCode: 400, statusMessage: '.xlsxファイルだけ登録できます' })
  }
  if (file.data.byteLength === 0 || file.data.byteLength > SECURITY_LIMITS.excelUploadBytes) {
    throw createError({ statusCode: file.data.byteLength > SECURITY_LIMITS.excelUploadBytes ? 413 : 400, statusMessage: 'Excelファイルは20MiB以下にしてください' })
  }
  if (file.type && !ACCEPTED_MIME_TYPES.has(file.type)) {
    throw createError({ statusCode: 400, statusMessage: 'ExcelファイルのMIMEタイプが不正です' })
  }
  if (file.data[0] !== 0x50 || file.data[1] !== 0x4b) {
    throw createError({ statusCode: 400, statusMessage: '有効な.xlsxファイルではありません' })
  }
  try {
    validateXlsxArchive(file.data)
  } catch (error) {
    if (error instanceof UnsafeExcelArchiveError || error instanceof SecurityFoundationError) {
      throw createError({ statusCode: 400, statusMessage: error.message, data: { code: error.code } })
    }
    throw error
  }

  try {
    const store = useProjectStore()
    return { project: await store.view(await store.saveExcel(projectId, fileName, file.data)) }
  } catch (error) {
    return toApiError(error)
  }
})
