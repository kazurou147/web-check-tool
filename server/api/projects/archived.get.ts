import { useProjectStore } from '~/server/services/project-store'

export default defineEventHandler(async () => {
  return { projects: await useProjectStore().list(true) }
})
