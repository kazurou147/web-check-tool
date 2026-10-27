import { verifyCsrfToken } from '~/server/services/csrf'
import { CSRF_HEADER, validateLocalApiRequest } from '~/server/services/local-api-security'

export default defineEventHandler((event) => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return
  setResponseHeaders(event, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  const failure = validateLocalApiRequest({
    method: event.method,
    path,
    host: getHeader(event, 'host'),
    origin: getHeader(event, 'origin'),
    fetchSite: getHeader(event, 'sec-fetch-site'),
    contentType: getHeader(event, 'content-type'),
    contentLength: getHeader(event, 'content-length'),
    csrfToken: getHeader(event, CSRF_HEADER),
  }, verifyCsrfToken)
  if (failure) {
    throw createError({
      statusCode: failure.statusCode,
      statusMessage: failure.message,
      data: { code: failure.code },
    })
  }
})
