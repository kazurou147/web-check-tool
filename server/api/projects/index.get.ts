import { useProjectStore } from '~/server/services/project-store'
import { attachRunSummaries } from '~/server/services/project-run-summary'
import { useRunStore } from '~/server/services/run-engine'

export default defineEventHandler(async () => {
  return { projects: await attachRunSummaries(await useProjectStore().list(false), useRunStore()) }
})
