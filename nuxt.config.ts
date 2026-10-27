import type { NitroConfig } from 'nitropack'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  devServer: { host: '127.0.0.1' },
  runtimeConfig: {
    dataDir: process.env.DATA_DIR || './data',
  },
  hooks: {
    'nitro:config'(config) {
      const nitroConfig = config as NitroConfig

      // These workarounds are only required when bundling the production server.
      // Applying custom export conditions in development makes Nitro emit broken
      // relative imports for @nuxt/nitro-server on Windows.
      if (nitroConfig.dev) {
        return
      }

      nitroConfig.externals = {
        ...nitroConfig.externals,
        inline: ['exceljs', 'dayjs', 'generator-function', 'is-generator-function'],
        exportConditions: ['node', 'import', 'require', 'default', 'module-sync'],
      }
    },
  },
})
