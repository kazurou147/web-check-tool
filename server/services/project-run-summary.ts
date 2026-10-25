import type { ProjectListItem, ProjectView } from '~/shared/types/project'
import type { RunListResult, RunStore } from './run-store'

const PROJECT_RUN_READ_CONCURRENCY = 4

export async function attachRunSummaries(projects: ProjectView[], runStore: RunStore): Promise<ProjectListItem[]> {
  return mapWithConcurrency(projects, PROJECT_RUN_READ_CONCURRENCY, async project => {
    const history: RunListResult = await runStore.listDetailed(project.projectId)
    const latestRun = history.runs[0] ?? null
    const completed = history.runs.find(run => run.status === 'completed') ?? null
    return {
      ...project,
      latestRun,
      latestCompletedRun: latestRun?.status === 'completed' ? null : completed,
      historyHealth: history.health,
    }
  })
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, mapper: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
