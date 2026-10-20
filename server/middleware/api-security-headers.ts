export default defineEventHandler((event) => {
  if (!getRequestURL(event).pathname.startsWith('/api/')) return
  setResponseHeaders(event, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
})
