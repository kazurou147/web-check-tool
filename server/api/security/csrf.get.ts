import { getCsrfToken } from '~/server/services/csrf'

export default defineEventHandler(() => ({ token: getCsrfToken() }))
