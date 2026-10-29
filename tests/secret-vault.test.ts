import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseEncryptionKey, SecretVault } from '~/server/services/secret-vault'
import { PasswordProtectedSecretStore } from '~/server/services/password-protected-secret-store'

describe('SecretVault', () => {
  let dataDir: string
  const projectId = '4a4763c1-cd9e-45c0-af5a-7a03f64cf6d2'

  beforeEach(async () => {
    dataDir = await mkdtemp(join(process.cwd(), '.test-data-secrets-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('AES-256-GCMで暗号化し、平文をファイルへ残さない', async () => {
    const key = randomBytes(32)
    const vault = new SecretVault(dataDir, () => key)
    const secrets = { basic: { username: 'client-user', password: 'very-secret-password' } }

    await vault.write(projectId, secrets)
    const raw = await readFile(join(dataDir, 'projects', projectId, 'secrets.enc.json'), 'utf8')

    expect(raw).not.toContain('client-user')
    expect(raw).not.toContain('very-secret-password')
    await expect(vault.read(projectId)).resolves.toEqual(secrets)
  })

  it('案件IDが異なると認証タグ検証に失敗する', async () => {
    const key = randomBytes(32)
    const vault = new SecretVault(dataDir, () => key)
    await vault.write(projectId, { form: { username: 'u', password: 'p' } })

    const source = join(dataDir, 'projects', projectId, 'secrets.enc.json')
    const otherId = 'f0837f5a-68b7-4452-bfac-15f56bbb3484'
    const destination = join(dataDir, 'projects', otherId, 'secrets.enc.json')
    const { mkdir, copyFile } = await import('node:fs/promises')
    await mkdir(join(dataDir, 'projects', otherId), { recursive: true })
    await copyFile(source, destination)

    await expect(vault.read(otherId)).rejects.toThrow()
  })

  it('パスワード保護は暗号鍵なしで専用ファイルへ平文保存する', async () => {
    const store = new PasswordProtectedSecretStore(dataDir)
    await store.write(projectId, 'protected-secret')
    const raw = await readFile(join(dataDir, 'projects', projectId, 'password-protected.secret.json'), 'utf8')

    expect(raw).toContain('protected-secret')
    expect(await store.read(projectId)).toBe('protected-secret')
    expect(await store.exists(projectId)).toBe(true)
    await store.delete(projectId)
    expect(await store.exists(projectId)).toBe(false)
  })

  it('32バイト以外の鍵を拒否する', () => {
    expect(() => parseEncryptionKey('short')).toThrow(/32バイト/)
  })
})
