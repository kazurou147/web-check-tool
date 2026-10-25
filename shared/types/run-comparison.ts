import type { RunStatus, Verdict } from './run'

export type ComparisonCategory = 'aggregate' | 'detail' | 'ai' | 'input'
export type ComparisonConfidence = 'exact' | 'semantic' | 'uncertain'
export type ComparisonPresence = 'matched' | 'added' | 'removed' | 'unobserved'
export type ComparisonIssueOutcome =
  | 'ng_resolved'
  | 'ng_introduced'
  | 'ng_continued'
  | 'verdict_changed'
  | 'became_unchecked'
  | 'became_excluded'
  | 'none'
  | 'indeterminate'

export interface ComparisonRunDescriptor {
  runId: string
  rerunOfRunId?: string
  status: RunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
  totalPages: number
  completedPages: number
}

export interface ComparisonValueSnapshot {
  stableKey: string
  verdict: Verdict
  detailStatus: string
  message: string
  expected?: unknown
  actual?: unknown
  pageNames: string[]
  sourceRows: number[]
}

export interface ComparisonChange {
  key: string
  category: ComparisonCategory
  entityType: string
  item: string
  pageUrl: string
  pageNames: string[]
  sourceRows: number[]
  device?: string
  presence: ComparisonPresence
  confidence: ComparisonConfidence
  issueOutcome: ComparisonIssueOutcome
  changeKinds: Array<'verdict' | 'expected' | 'actual' | 'reason' | 'detail_status' | 'metadata' | 'presence'>
  before?: ComparisonValueSnapshot
  after?: ComparisonValueSnapshot
}

export interface ComparisonCounts {
  changed: number
  ngResolved: number
  ngIntroduced: number
  ngContinued: number
  added: number
  removed: number
  unobserved: number
  uncertain: number
}

export interface ConditionDifference {
  key: string
  label: string
  before: string
  after: string
}

export interface RunComparisonResponse {
  schemaVersion: 1
  projectId: string
  reliability: 'complete' | 'partial'
  base: ComparisonRunDescriptor
  target: ComparisonRunDescriptor
  warnings: string[]
  conditionDifferences: ConditionDifference[]
  summary: Record<ComparisonCategory, ComparisonCounts> & {
    verdictTransitions: Record<string, number>
  }
  changes: ComparisonChange[]
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

export interface RunComparisonQuery {
  base: string
  target: string
  category?: ComparisonCategory
  pageUrl?: string
  item?: string
  page: number
  pageSize: number
}
