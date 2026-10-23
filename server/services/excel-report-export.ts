import type { ProjectStore } from './project-store'
import type { RunStore } from './run-store'
import { buildExcelReport } from './excel-report'

export interface ExcelReportExportDependencies {
  projectStore: ProjectStore
  runStore: RunStore
  builder?: typeof buildExcelReport
}

export async function generateExcelReport(
  projectId: string,
  runId: string,
  dependencies: ExcelReportExportDependencies,
): Promise<{ fileName: string; size: number }> {
  const project = await dependencies.projectStore.get(projectId)
  const result = await dependencies.runStore.get(projectId, runId)
  const bytes = await (dependencies.builder ?? buildExcelReport)(project, result)
  await dependencies.runStore.saveReport(projectId, runId, bytes)
  return { fileName: reportDownloadName(runId), size: bytes.byteLength }
}

export function reportDownloadName(runId: string): string {
  return `web-check-report-${runId}.xlsx`
}
