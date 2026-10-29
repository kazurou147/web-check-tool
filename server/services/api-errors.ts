import { ArchivedProjectError, ProjectNotFoundError } from './project-store'
import { RunCorruptError, RunNotFoundError, RunTooLargeError } from './run-store'
import { PasswordProtectedSecretStoreError } from './password-protected-secret-store'

export function toApiError(error: unknown): never {
  if (error instanceof ProjectNotFoundError) {
    throw createError({ statusCode: 404, statusMessage: error.message })
  }
  if (error instanceof ArchivedProjectError) {
    throw createError({ statusCode: 409, statusMessage: error.message })
  }
  if (error instanceof RunNotFoundError) {
    throw createError({ statusCode: 404, statusMessage: '指定された案件の検査結果が見つかりません' })
  }
  if (error instanceof RunCorruptError) {
    throw createError({ statusCode: 422, statusMessage: '指定された検査履歴は破損しているため読み取れません' })
  }
  if (error instanceof RunTooLargeError) {
    throw createError({ statusCode: 413, statusMessage: '指定された検査履歴は読込サイズ上限を超えています' })
  }
  if (error instanceof PasswordProtectedSecretStoreError) {
    throw createError({ statusCode: 500, statusMessage: error.message })
  }
  throw error
}
