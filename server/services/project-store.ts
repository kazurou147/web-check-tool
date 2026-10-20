import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Project, ProjectSettings, ProjectView } from '~/shared/types/project'
import { projectIdSchema } from './validation'
import { SecretVault } from './secret-vault'

export class ArchivedProjectError extends Error {}
export class ProjectNotFoundError extends Error {}

export class ProjectStore {
  readonly projectsDir: string
  readonly vault: SecretVault

  constructor(readonly dataDir: string = resolveDataDir()) {
    this.projectsDir = join(dataDir, 'projects')
    this.vault = new SecretVault(dataDir)
  }

  private projectDir(projectId: string): string {
    projectIdSchema.parse(projectId)
    return join(this.projectsDir, projectId)
  }

  private projectPath(projectId: string): string {
    return join(this.projectDir(projectId), 'project.json')
  }

  excelPath(projectId: string): string {
    return join(this.projectDir(projectId), 'input', 'current.xlsx')
  }

  async create(name: string, settings: ProjectSettings): Promise<Project> {
    const projectId = randomUUID()
    const now = new Date().toISOString()
    const project: Project = {
      schemaVersion: 1,
      projectId,
      name,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      excelFileName: '',
      settings,
    }
    const projectDir = this.projectDir(projectId)
    await mkdir(join(projectDir, 'input'), { recursive: true })
    await mkdir(join(projectDir, 'runs'), { recursive: true })
    await atomicWriteJson(this.projectPath(projectId), project)
    return project
  }

  async get(projectId: string): Promise<Project> {
    try {
      const project = JSON.parse(await readFile(this.projectPath(projectId), 'utf8')) as Project
      if (project.schemaVersion !== 1 || project.projectId !== projectId) {
        throw new Error('案件データの形式が不正です')
      }
      return project
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ProjectNotFoundError('案件が見つかりません')
      }
      throw error
    }
  }

  async view(project: Project): Promise<ProjectView> {
    return { ...project, credentialsConfigured: await this.vault.exists(project.projectId) }
  }

  async list(archived: boolean): Promise<ProjectView[]> {
    await mkdir(this.projectsDir, { recursive: true })
    const entries = await readdir(this.projectsDir, { withFileTypes: true })
    const projects = await Promise.all(entries
      .filter(entry => entry.isDirectory() && projectIdSchema.safeParse(entry.name).success)
      .map(entry => this.get(entry.name)))
    const selected = projects.filter(project => Boolean(project.archivedAt) === archived)
    selected.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return Promise.all(selected.map(project => this.view(project)))
  }

  async update(projectId: string, changes: { name?: string; settings?: ProjectSettings; excelFileName?: string }): Promise<Project> {
    const project = await this.get(projectId)
    if (project.archivedAt) throw new ArchivedProjectError('アーカイブ中の案件は編集できません')
    const updated: Project = { ...project, ...changes, updatedAt: new Date().toISOString() }
    await atomicWriteJson(this.projectPath(projectId), updated)
    return updated
  }

  async setArchived(projectId: string, archived: boolean): Promise<Project> {
    const project = await this.get(projectId)
    if (Boolean(project.archivedAt) === archived) return project
    const now = new Date().toISOString()
    const updated: Project = {
      ...project,
      archivedAt: archived ? now : null,
      updatedAt: now,
    }
    await atomicWriteJson(this.projectPath(projectId), updated)
    return updated
  }

  async saveExcel(projectId: string, fileName: string, bytes: Uint8Array): Promise<Project> {
    const project = await this.get(projectId)
    if (project.archivedAt) throw new ArchivedProjectError('アーカイブ中の案件はExcelを変更できません')
    const target = this.excelPath(projectId)
    await atomicWriteBytes(target, bytes)
    return this.update(projectId, { excelFileName: fileName })
  }

  async assertPhaseOneFiles(projectId: string): Promise<void> {
    await stat(this.projectPath(projectId))
    await stat(join(this.projectDir(projectId), 'input'))
    await stat(join(this.projectDir(projectId), 'runs'))
  }
}

export function resolveDataDir(value = process.env.DATA_DIR || './data'): string {
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value)
}

let singleton: ProjectStore | undefined
export function useProjectStore(): ProjectStore {
  singleton ??= new ProjectStore()
  return singleton
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteBytes(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporaryPath, bytes, { flag: 'wx' })
  await rename(temporaryPath, path)
}
