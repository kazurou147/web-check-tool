import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface PasswordProtectedSecretFile {
  schemaVersion: 1
  password: string
}

export class PasswordProtectedSecretStoreError extends Error {}

export class PasswordProtectedSecretStore {
  constructor(private readonly dataDir: string) {}

  private pathFor(projectId: string): string {
    return join(this.dataDir, 'projects', projectId, 'password-protected.secret.json')
  }

  async exists(projectId: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(projectId))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw storageError('パスワード保護の保存状態を確認できませんでした。', error)
    }
  }

  async write(projectId: string, password: string): Promise<void> {
    const target = this.pathFor(projectId)
    const temporaryPath = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    const value: PasswordProtectedSecretFile = { schemaVersion: 1, password }
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' })
      await rename(temporaryPath, target)
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      throw storageError('パスワード保護のパスワードを保存できませんでした。', error)
    }
  }

  async read(projectId: string): Promise<string> {
    try {
      const value = JSON.parse(await readFile(this.pathFor(projectId), 'utf8')) as Partial<PasswordProtectedSecretFile>
      if (value.schemaVersion !== 1 || typeof value.password !== 'string' || !value.password) {
        throw new Error('invalid password-protected secret file')
      }
      return value.password
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PasswordProtectedSecretStoreError('パスワード保護のパスワードが保存されていません。')
      }
      throw storageError('パスワード保護のパスワードを読み込めませんでした。', error)
    }
  }

  async delete(projectId: string): Promise<void> {
    try {
      await unlink(this.pathFor(projectId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw storageError('パスワード保護のパスワードを削除できませんでした。', error)
    }
  }
}

function storageError(message: string, cause: unknown): PasswordProtectedSecretStoreError {
  return new PasswordProtectedSecretStoreError(message, { cause })
}
