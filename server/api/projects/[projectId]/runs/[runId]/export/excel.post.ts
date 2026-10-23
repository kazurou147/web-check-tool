import { toApiError } from '~/server/services/api-errors'
import { ExcelReportNotReadyError } from '~/server/services/excel-report'
import { generateExcelReport } from '~/server/services/excel-report-export'
import { ProjectNotFoundError, useProjectStore } from '~/server/services/project-store'
import { requireProjectId, requireRunId } from '~/server/services/request'
import { RunNotFoundError } from '~/server/services/run-store'
import { useRunStore } from '~/server/services/run-engine'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const runId = requireRunId(event)
  try {
    const generated = await generateExcelReport(projectId, runId, {
      projectStore: useProjectStore(),
      runStore: useRunStore(),
    })
    return { ...generated, generatedAt: new Date().toISOString() }
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof RunNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: '指定された案件の検査結果が見つかりません' })
    }
    if (error instanceof ExcelReportNotReadyError) {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    return toApiError(error)
  }
})
