import type { H3Event, MultiPartData } from 'h3'
import { getRequestHeader, getRequestWebStream } from 'h3'
import { SECURITY_ERROR_CODES, SecurityFoundationError } from '~/shared/security/security-constants'

const MULTIPART_OVERHEAD_BYTES = 64 * 1024

export async function readLimitedMultipartFormData(event: H3Event, fileLimitBytes: number): Promise<MultiPartData[] | undefined> {
  const contentType = getRequestHeader(event, 'content-type')
  if (!contentType?.toLowerCase().startsWith('multipart/form-data')) return undefined
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean)?.trim()
  if (!boundary) return undefined

  const requestLimit = fileLimitBytes + MULTIPART_OVERHEAD_BYTES
  const declared = Number(getRequestHeader(event, 'content-length') ?? '0')
  if (Number.isFinite(declared) && declared > requestLimit) throw requestTooLarge()

  const stream = getRequestWebStream(event)
  if (!stream) return undefined
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > requestLimit) {
        await reader.cancel().catch(() => undefined)
        throw requestTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return parseMultipart(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), boundary)
}

function parseMultipart(body: Buffer, boundary: string): MultiPartData[] {
  const marker = Buffer.from(`--${boundary}`)
  const separator = Buffer.from(`\r\n--${boundary}`)
  const parts: MultiPartData[] = []
  let cursor = body.indexOf(marker)
  if (cursor < 0) return parts
  cursor += marker.length
  while (cursor < body.length) {
    if (body.subarray(cursor, cursor + 2).toString() === '--') break
    if (body.subarray(cursor, cursor + 2).toString() !== '\r\n') break
    cursor += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
    if (headerEnd < 0) break
    const headers = body.subarray(cursor, headerEnd).toString('latin1')
    const next = body.indexOf(separator, headerEnd + 4)
    if (next < 0) break
    const disposition = headers.split('\r\n').find(line => /^content-disposition:/i.test(line)) ?? ''
    const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1]
    const filename = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1]
    const type = headers.split('\r\n').find(line => /^content-type:/i.test(line))?.split(':').slice(1).join(':').trim()
    parts.push({
      data: body.subarray(headerEnd + 4, next),
      ...(name === undefined ? {} : { name }),
      ...(filename === undefined ? {} : { filename }),
      ...(type === undefined ? {} : { type }),
    })
    cursor = next + 2 + marker.length
  }
  return parts
}

function requestTooLarge(): SecurityFoundationError {
  return new SecurityFoundationError(SECURITY_ERROR_CODES.requestTooLarge, 'アップロードサイズが上限を超えています。')
}
