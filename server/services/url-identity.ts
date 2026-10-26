import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SECURITY_ERROR_CODES,
  SecurityFoundationError,
} from '~/shared/security/security-constants'
import { normalizeHttpUrlForIdentity } from '~/shared/security/url-security'

export const URL_IDENTITY_ALGORITHM = 'HMAC-SHA256'
export const URL_IDENTITY_VERSION = 'url-hmac-v1'
export const URL_IDENTITY_KEY_FILE = '.url-identity-key'
const KEY_BYTES = 32
const DERIVATION_CONTEXT = 'website-delivery-checker:url-identity-key:v1'
const IDENTITY_CONTEXT = 'website-delivery-checker:url-identity:v1'

/** 明示的な初期化専用です。既存鍵がある場合は上書きも再利用もしません。 */
export async function createUrlIdentityKey(dataDir: string, masterKey?: string): Promise<Buffer> {
  const key = masterKey ? deriveUrlIdentityKey(masterKey) : randomBytes(KEY_BYTES)
  const path = urlIdentityKeyPath(dataDir)
  try {
    await mkdir(dataDir, { recursive: true })
    await writeFile(path, `${key.toString('base64')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SecurityFoundationError(
        SECURITY_ERROR_CODES.urlIdentityKeyExists,
        'URL識別鍵はすでに存在します。',
      )
    }
    throw new SecurityFoundationError(
      SECURITY_ERROR_CODES.urlIdentityKeyIoFailed,
      'URL識別鍵を保存できませんでした。',
    )
  }
}

/** 欠落時には新規生成せず、安全に失敗します。 */
export async function loadUrlIdentityKey(dataDir: string): Promise<Buffer> {
  try {
    return decodeKey(await readFile(urlIdentityKeyPath(dataDir), 'utf8'))
  } catch (error) {
    if (error instanceof SecurityFoundationError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SecurityFoundationError(
        SECURITY_ERROR_CODES.urlIdentityKeyMissing,
        'URL識別鍵が見つかりません。データ領域のバックアップから復元してください。',
      )
    }
    throw new SecurityFoundationError(
      SECURITY_ERROR_CODES.urlIdentityKeyIoFailed,
      'URL識別鍵を読み込めませんでした。',
    )
  }
}

export function createUrlIdentity(value: string, key: Uint8Array): string {
  assertKey(key)
  const normalized = normalizeHttpUrlForIdentity(value)
  const digest = createHmac('sha256', key)
    .update(`${IDENTITY_CONTEXT}\n${normalized}`, 'utf8')
    .digest('hex')
  return `${URL_IDENTITY_VERSION}:${digest}`
}

export function deriveUrlIdentityKey(masterKey: string): Buffer {
  const decoded = decodeMasterKey(masterKey)
  return createHmac('sha256', decoded).update(DERIVATION_CONTEXT, 'utf8').digest()
}

export function urlIdentityKeyPath(dataDir: string): string {
  return join(dataDir, URL_IDENTITY_KEY_FILE)
}

function decodeStoredKey(value: string): Buffer {
  const encoded = value.trim()
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('invalid base64')
  }
  const decoded = Buffer.from(encoded, 'base64')
  assertKey(decoded)
  return decoded
}

function decodeKey(value: string): Buffer {
  try {
    return decodeStoredKey(value)
  } catch {
    throw new SecurityFoundationError(
      SECURITY_ERROR_CODES.urlIdentityKeyInvalid,
      '保存済みURL識別鍵の形式が不正です。',
    )
  }
}

function decodeMasterKey(value: string): Buffer {
  try {
    const encoded = value.trim()
    const decoded = /^[0-9a-f]{64}$/i.test(encoded)
      ? Buffer.from(encoded, 'hex')
      : /^[A-Za-z0-9+/]{43}=$/.test(encoded)
        ? Buffer.from(encoded, 'base64')
        : Buffer.alloc(0)
    assertKey(decoded)
    return decoded
  } catch {
    throw new SecurityFoundationError(
      SECURITY_ERROR_CODES.urlIdentityKeyInvalid,
      'URL識別鍵の生成元は32バイトで指定してください。',
    )
  }
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new SecurityFoundationError(
      SECURITY_ERROR_CODES.urlIdentityKeyInvalid,
      'URL識別鍵は32バイトである必要があります。',
    )
  }
}
