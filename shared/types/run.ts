import type { InputSnapshot } from './excel-input'
import type { AuthMode } from './project'

export type Verdict = 'ng' | 'needs_review' | 'unchecked' | 'ok'
export type RunStatus =
  | 'queued'
  | 'reading_input'
  | 'authenticating'
  | 'checking'
  | 'ai_checking'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted'

export type FindingItem =
  | 'page_fetch'
  | 'title'
  | 'description'
  | 'google_tags'
  | 'links'
  | 'images'

export interface SafeError {
  code: string
  message: string
  retryable: boolean
}

export interface Finding {
  key: string
  item: FindingItem
  verdict: Verdict
  detailStatus: string
  url: string
  pageNames: string[]
  sourceRows: number[]
  expected?: unknown
  actual?: unknown
  message: string
  evidence: string[]
  device?: ImageDevice
}

export interface PageResult {
  normalizedUrl: string
  requestedUrl: string
  finalUrl?: string
  pageNames: string[]
  sourceRows: number[]
  startedAt: string
  finishedAt: string
  attempts: number
  httpStatus?: number
  findings: Finding[]
  error?: SafeError
}

export type GoogleTagDetectionMethod = 'html_direct' | 'gtm_delivered' | 'network'
export type GoogleTagInstallationMethod = 'direct' | 'gtm' | 'unknown'
export type GoogleTagType = 'gtm' | 'ga4' | 'google_ads' | 'google_tag' | 'floodlight'

export interface GoogleTagDetection {
  key: string
  pageUrl: string
  id: string
  tagType: GoogleTagType
  detectionMethod: GoogleTagDetectionMethod
  installationMethod: GoogleTagInstallationMethod
  evidence: string[]
  verdict: Verdict
  verdictReason: string
  relatedDetectionKeys: string[]
  location?: 'head' | 'body' | 'unknown'
  occurrences: number
}

export type LinkKind = 'http' | 'pdf' | 'anchor' | 'mailto' | 'tel' | 'non_http' | 'empty'

export interface LinkResult {
  key: string
  pageUrl: string
  href: string
  resolvedUrl?: string
  finalUrl?: string
  kind: LinkKind
  verdict: Verdict
  status?: number
  contentType?: string
  redirectCount: number
  isImageLink: boolean
  message: string
  evidence: string[]
}

export type ImageDevice = 'desktop' | 'mobile'
export type ImageSourceKind = 'img' | 'picture' | 'srcset' | 'css_background' | 'pseudo_before' | 'pseudo_after'

export interface ImageResult {
  key: string
  pageUrl: string
  device: ImageDevice
  imageUrl: string
  sourceKind: ImageSourceKind
  location: string
  verdict: Verdict
  message: string
  evidence: string[]
}

export interface SanitizedRunConfig {
  pageConcurrency: 1 | 2 | 3
  navigationTimeoutMs: number
  retryCount: number
  maxRedirects: number
  maxResponseBytes: number
  linkTimeoutMs: number
  imageTimeoutMsPerDevice: number
  imageScrollWaitMs: number
  authMode: AuthMode
  allowedPrivateHosts: string[]
  viewports: {
    desktop: { width: 1366; height: 768 }
    mobile: { width: 375; height: 667 }
  }
}

export interface RunResult {
  schemaVersion: 1
  runId: string
  projectId: string
  rerunOfRunId?: string
  status: RunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
  configSnapshot: SanitizedRunConfig
  input: InputSnapshot
  summary: { ng: number; needsReview: number; unchecked: number; ok: number }
  pages: PageResult[]
  links: LinkResult[]
  images: ImageResult[]
  googleTagDetections: GoogleTagDetection[]
  aiUsage: {
    enabled: false
    inputTokens: 0
    outputTokens: 0
    estimatedCostUsd: 0
    costLimitUsd: number
    stoppedByCostLimit: false
  }
  fatalError?: SafeError
}

export interface RunSummary {
  runId: string
  status: RunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
  totalPages: number
  completedPages: number
  summary: RunResult['summary']
  fatalError?: SafeError
}
