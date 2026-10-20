import { ArchivedProjectError, ProjectNotFoundError } from './project-store'

export function toApiError(error: unknown): never {
  if (error instanceof ProjectNotFoundError) {
    throw createError({ statusCode: 404, statusMessage: error.message })
  }
  if (error instanceof ArchivedProjectError) {
    throw createError({ statusCode: 409, statusMessage: error.message })
  }
  throw error
}
