import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArchivedProjectError, ProjectStore } from '~/server/services/project-store'
import { defaultProjectSettings } from '~/shared/types/project'

describe('ProjectStore', () => {
  let dataDir: string
  let store: ProjectStore

  beforeEach(async () => {
    dataDir = await mkdtemp(join(process.cwd(), '.test-data-projects-'))
    process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    store = new ProjectStore(dataDir)
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
    delete process.env.APP_ENCRYPTION_KEY
  })

  it('UUID案件フォルダとJSONを作成する', async () => {
    const project = await store.create('コーポレートサイト', defaultProjectSettings())

    expect(project.projectId).toMatch(/^[0-9a-f-]{36}$/)
    await expect(store.assertPhaseOneFiles(project.projectId)).resolves.toBeUndefined()
    const saved = await store.get(project.projectId)
    expect(saved).toEqual(project)
    expect(await store.list(false)).toHaveLength(1)
    expect(await store.list(true)).toHaveLength(0)
  })

  it('AI設定がない旧案件をoffとして読み込む', async () => {
    const project = await store.create('旧案件', defaultProjectSettings())
    const path = join(dataDir, 'projects', project.projectId, 'project.json')
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    delete legacy.settings.ai
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`)

    const loaded = await store.get(project.projectId)
    expect(loaded.settings.ai).toEqual({ mode: 'off' })
  })

  it('Excelをcurrent.xlsxへコピーし、渡された原本バイト列を変更しない', async () => {
    const project = await store.create('LP', defaultProjectSettings())
    const source = Buffer.from('PK\u0003\u0004fixture-xlsx')
    const sourceHash = createHash('sha256').update(source).digest('hex')

    const updated = await store.saveExcel(project.projectId, '顧客原本.xlsx', source)
    const copied = await readFile(join(dataDir, 'projects', project.projectId, 'input', 'current.xlsx'))

    expect(updated.excelFileName).toBe('顧客原本.xlsx')
    expect(copied).toEqual(source)
    expect(createHash('sha256').update(source).digest('hex')).toBe(sourceHash)
  })

  it('アーカイブと解除は冪等で、Excelと履歴ファイルを変更しない', async () => {
    const project = await store.create('採用サイト', defaultProjectSettings())
    await store.saveExcel(project.projectId, 'input.xlsx', Buffer.from('PK\u0003\u0004data'))
    const runFile = join(dataDir, 'projects', project.projectId, 'runs', 'existing-result.json')
    await writeFile(runFile, '{"kept":true}')

    const archived = await store.setArchived(project.projectId, true)
    const archivedAgain = await store.setArchived(project.projectId, true)
    expect(archivedAgain.archivedAt).toBe(archived.archivedAt)
    expect(await readFile(runFile, 'utf8')).toBe('{"kept":true}')
    expect(await readFile(join(dataDir, 'projects', project.projectId, 'input', 'current.xlsx'))).toEqual(Buffer.from('PK\u0003\u0004data'))
    await expect(store.update(project.projectId, { name: '変更不可' })).rejects.toBeInstanceOf(ArchivedProjectError)
    await expect(store.saveExcel(project.projectId, 'new.xlsx', Buffer.from('PKnew'))).rejects.toBeInstanceOf(ArchivedProjectError)

    const restored = await store.setArchived(project.projectId, false)
    expect(restored.archivedAt).toBeNull()
    expect(await readFile(runFile, 'utf8')).toBe('{"kept":true}')
  })
})
