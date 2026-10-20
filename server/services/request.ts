import { ZodError, type ZodType } from 'zod'
import { projectIdSchema } from './validation'

export async function readValidatedBody<T>(event: Parameters<typeof readBody>[0], schema: ZodType<T>): Promise<T> {
  try {
    return schema.parse(await readBody(event))
  } catch (error) {
    if (error instanceof ZodError) {
      throw createError({
        statusCode: 400,
        statusMessage: '入力内容を確認してください',
        data: error.issues,
      })
    }
    throw error
  }
}

export function requireProjectId(event: Parameters<typeof getRouterParam>[0]): string {
  const result = projectIdSchema.safeParse(getRouterParam(event, 'projectId'))
  if (!result.success) throw createError({ statusCode: 400, statusMessage: '案件IDが不正です' })
  return result.data
}

export function requireRunId(event: Parameters<typeof getRouterParam>[0]): string {
  const result = projectIdSchema.safeParse(getRouterParam(event, 'runId'))
  if (!result.success) throw createError({ statusCode: 400, statusMessage: '検査IDが不正です' })
  return result.data
}
