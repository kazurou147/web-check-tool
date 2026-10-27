import { readFile, stat } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { SECURITY_ERROR_CODES, SECURITY_LIMITS, SecurityFoundationError } from '~/shared/security/security-constants'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_MIN_BYTES = 22
const EOCD_SEARCH_BYTES = 65_535 + EOCD_MIN_BYTES

export class UnsafeExcelArchiveError extends SecurityFoundationError {
  constructor(message: string) {
    super(SECURITY_ERROR_CODES.excelArchiveUnsafe, message)
    this.name = 'UnsafeExcelArchiveError'
  }
}

export async function readAndValidateXlsx(filePath: string): Promise<Buffer> {
  const size = (await stat(filePath)).size
  if (size <= 0 || size > SECURITY_LIMITS.excelUploadBytes) {
    throw new SecurityFoundationError(SECURITY_ERROR_CODES.requestTooLarge, 'Excelファイルは20MiB以下にしてください。')
  }
  const bytes = await readFile(filePath)
  validateXlsxArchive(bytes)
  return bytes
}

export function validateXlsxArchive(bytes: Uint8Array): void {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buffer.length <= 0 || buffer.length > SECURITY_LIMITS.excelUploadBytes) {
    throw new SecurityFoundationError(SECURITY_ERROR_CODES.requestTooLarge, 'Excelファイルは20MiB以下にしてください。')
  }
  const searchStart = Math.max(0, buffer.length - EOCD_SEARCH_BYTES)
  let eocd = -1
  for (let offset = buffer.length - EOCD_MIN_BYTES; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE
      && offset + EOCD_MIN_BYTES + buffer.readUInt16LE(offset + 20) === buffer.length) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw unsafe('xlsxのZIP終端情報を確認できません。')

  const disk = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw unsafe('複数ディスクZIPは利用できません。')
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw unsafe('ZIP64形式は利用できません。')
  if (entryCount > SECURITY_LIMITS.excelZipEntries) throw unsafe('xlsxのZIPエントリ数が上限を超えています。')
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > buffer.length) throw unsafe('xlsxのZIP構造が不正です。')

  let cursor = centralOffset
  let expandedTotal = 0
  let compressedTotal = 0
  let verifiedExpandedTotal = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw unsafe('xlsxのZIPエントリが不正です。')
    const flags = buffer.readUInt16LE(cursor + 8)
    const compressionMethod = buffer.readUInt16LE(cursor + 10)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const expanded = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if ((flags & 0x1) !== 0) throw unsafe('暗号化ZIPは利用できません。')
    if (compressionMethod !== 0 && compressionMethod !== 8) throw unsafe('xlsxに未対応のZIP圧縮方式が含まれています。')
    expandedTotal += expanded
    compressedTotal += compressed
    if (expandedTotal > SECURITY_LIMITS.excelExpandedBytes) throw unsafe('xlsxの展開後サイズが上限を超えています。')
    if (expanded > 0 && (compressed === 0 || expanded / compressed > SECURITY_LIMITS.excelZipCompressionRatio)) {
      throw unsafe('xlsxのZIP圧縮率が安全上限を超えています。')
    }
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw unsafe('xlsxのZIPローカルエントリが不正です。')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressed > centralOffset) throw unsafe('xlsxのZIP圧縮データ範囲が不正です。')
    const compressedData = buffer.subarray(dataStart, dataStart + compressed)
    const remainingExpanded = SECURITY_LIMITS.excelExpandedBytes - verifiedExpandedTotal
    const ratioExpanded = compressed === 0 ? 0 : compressed * SECURITY_LIMITS.excelZipCompressionRatio
    const maximumOutput = Math.min(remainingExpanded, ratioExpanded)
    let actualExpanded: number
    try {
      actualExpanded = compressionMethod === 0
        ? compressedData.length
        : inflateRawSync(compressedData, { maxOutputLength: Math.max(1, maximumOutput + 1) }).length
    } catch {
      throw unsafe('xlsxの展開データがサイズまたは圧縮率の上限を超えています。')
    }
    if (actualExpanded !== expanded) throw unsafe('xlsxのZIP展開サイズ情報が一致しません。')
    verifiedExpandedTotal += actualExpanded
    if (verifiedExpandedTotal > SECURITY_LIMITS.excelExpandedBytes
      || (compressed > 0 && actualExpanded / compressed > SECURITY_LIMITS.excelZipCompressionRatio)) {
      throw unsafe('xlsxの展開データがサイズまたは圧縮率の上限を超えています。')
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (cursor !== centralOffset + centralSize) throw unsafe('xlsxのZIP中央ディレクトリが不正です。')
  if (expandedTotal > 0 && (compressedTotal === 0 || expandedTotal / compressedTotal > SECURITY_LIMITS.excelZipCompressionRatio)) {
    throw unsafe('xlsx全体のZIP圧縮率が安全上限を超えています。')
  }
}

function unsafe(message: string): UnsafeExcelArchiveError {
  return new UnsafeExcelArchiveError(message)
}
