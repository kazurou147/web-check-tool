import type { InputSnapshot } from './excel-input'
import type { AuthMode } from './project'
import type { AiRunData } from './ai'

export type Verdict = 'ng' | 'needs_review' | 'unchecked' | 'excluded' | 'ok'
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

export type ActiveRunStatus = 'queued' | 'reading_input' | 'authenticating' | 'checking' | 'ai_checking'

export interface RunTermination {
  kind: 'canceled' | 'interrupted'
  reasonCode: 'USER_REQUESTED' | 'PROCESS_RESTART'
  previousStatus: ActiveRunStatus
  requestedAt?: string
  finalizedAt?: string
}

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
  imageViewportDiagnostics?: ImageViewportDiagnostics[]
  error?: SafeError
}

export type GoogleTagDetectionMethod = 'html_direct' | 'gtm_delivered' | 'google_tag_delivered' | 'network'
export type GoogleTagInstallationMethod = 'direct' | 'gtm' | 'google_tag' | 'unknown'
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
  sourceTagId?: string
  associationEvidence?: string[]
  location?: 'head' | 'body' | 'unknown'
  gtmBodyPlacements?: GtmBodyPlacement[]
  occurrences: number
}

export type GtmBodyPlacementStatus = 'recommended' | 'acceptable_not_first' | 'too_far' | 'nested' | 'unresolved'

export interface GtmBodyPlacement {
  directBodyChild: boolean
  elementPosition?: number
  sourceCharacterDistance: number
  status: GtmBodyPlacementStatus
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
  exclusion?: {
    reason: string
    hiddenBy: string
    cssSelector: string
    mediaCondition: string
  }
}

export type ImageScrollStopReason = 'bottom_stable' | 'time_limit' | 'scroll_limit' | 'no_progress' | 'aborted'

export interface ImageScrollDiagnostics {
  stopReason: ImageScrollStopReason
  scrollCount: number
  elapsedMs: number
  lastScrollY: number
  lastDocumentHeight: number
  viewportHeight: number
  bottomStableCount: number
  noProgressCount: number
  reachedStableBottom: boolean
}

export interface ImageViewportDiagnostics {
  device: ImageDevice
  scroll?: ImageScrollDiagnostics
  error?: string
}

export interface MobileEmulationSnapshot {
  deviceProfile: 'Pixel 5'
  userAgent: string
  viewport: { width: 375; height: 667 }
  screen: { width: 375; height: 667 }
  deviceScaleFactor: number
  isMobile: true
  hasTouch: true
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
  imageScrollStepViewportRatio?: number
  imageScrollMaxCount?: number
  imageScrollBottomStableCount?: number
  imageScrollNoProgressCount?: number
  authMode: AuthMode
  allowedPrivateHosts: string[]
  aiMode: 'off' | 'manual' | 'api'
  viewports: {
    desktop: { width: 1366; height: 768 }
    mobile: { width: 375; height: 667 }
  }
  mobileEmulation?: MobileEmulationSnapshot
}

export interface RunResult {
  schemaVersion: 1
  runId: string
  projectId: string
  rerunOfRunId?: string
  rerun?: RunRerunMetadata
  status: RunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
  configSnapshot: SanitizedRunConfig
  input: InputSnapshot
  summary: { ng: number; needsReview: number; unchecked: number; excluded?: number; ok: number }
  pages: PageResult[]
  links: LinkResult[]
  images: ImageResult[]
  googleTagDetections: GoogleTagDetection[]
  ai?: AiRunData
  aiUsage: {
    enabled: boolean
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    estimatedCostUsd: number
    costLimitUsd: number
    stoppedByCostLimit: boolean
    apiFailureCount: number
  }
  termination?: RunTermination
  fatalError?: SafeError
}

export interface RunRerunMetadata {
  sourceRunId: string
  configSource: 'current_project' | 'source_run'
  inputSource: 'current_excel'
  requestedAiMode: 'off' | 'manual' | 'api'
  requestedAt: string
  compatibilityWarnings?: string[]
}

export interface RunSummary {
  runId: string
  rerunOfRunId?: string
  status: RunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
  totalPages: number
  completedPages: number
  summary: RunResult['summary']
  termination?: RunTermination
  fatalError?: SafeError
}

export interface RunResultExport {
  schemaVersion: 1
  kind: 'web-check-result-export'
  exportedAt: string
  snapshot: { active: boolean; savedAt: string }
  masking: {
    ruleVersion: string
    maskedCount: number
    maskedCategories: string[]
    notice: string
  }
  result: RunResult
}
