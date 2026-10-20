import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectSecrets } from '~/shared/types/project'

interface EncryptedEnvelope {
  version: 1
  algorithm: 'aes-256-gcm'
  iv: string
  authTag: string
  ciphertext: string
}

export function parseEncryptionKey(value: string | undefined): Buffer {
  if (!value) {
    throw new Error('APP_ENCRYPTION_KEYが設定されていません')
  }
  const key = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64')
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEYは32バイトのBase64または64桁の16進数で指定してください')
  }
  return key
}

export class SecretVault {
  constructor(
    private readonly dataDir: string,
    private readonly keyProvider: () => Buffer = () => parseEncryptionKey(process.env.APP_ENCRYPTION_KEY),
  ) {}

  private pathFor(projectId: string): string {
    return join(this.dataDir, 'projects', projectId, 'secrets.enc.json')
  }

  async exists(projectId: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(projectId))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  async write(projectId: string, secrets: ProjectSecrets): Promise<void> {
    const key = this.keyProvider()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(projectId, 'utf8'))
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secrets), 'utf8'),
      cipher.final(),
    ])
    const envelope: EncryptedEnvelope = {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
    await atomicWrite(this.pathFor(projectId), JSON.stringify(envelope, null, 2))
  }

  async read(projectId: string): Promise<ProjectSecrets> {
    const envelope = JSON.parse(await readFile(this.pathFor(projectId), 'utf8')) as EncryptedEnvelope
    if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
      throw new Error('未対応の秘密情報フォーマットです')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.keyProvider(), Buffer.from(envelope.iv, 'base64'))
    decipher.setAAD(Buffer.from(projectId, 'utf8'))
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ])
    return JSON.parse(plaintext.toString('utf8')) as ProjectSecrets
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' })
  await rename(temporaryPath, path)
}
