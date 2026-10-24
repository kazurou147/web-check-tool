import { initializeApplicationRuntime, releaseApplicationRuntime, runtimeFailure } from '~/server/services/app-runtime'

export default defineNitroPlugin(async (nitroApp) => {
  await initializeApplicationRuntime().catch(() => {
    const failure = runtimeFailure()
    console.error('[runtime] startup recovery unavailable', {
      code: failure && 'code' in failure ? String(failure.code) : 'RUNTIME_INITIALIZATION_FAILED',
      errorType: failure?.name ?? 'UnknownError',
    })
  })
  nitroApp.hooks.hook('close', async () => {
    await releaseApplicationRuntime()
  })
})
