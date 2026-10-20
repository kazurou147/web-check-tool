export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    dataDir: process.env.DATA_DIR || './data',
  },
  nitro: {
    routeRules: {
      '/api/**': {
        cors: false,
        headers: {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      },
    },
  },
})
