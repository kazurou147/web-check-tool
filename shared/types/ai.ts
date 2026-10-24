export type AiMode = 'off' | 'manual' | 'api'
export type AiVerdict = 'match' | 'possible_mismatch' | 'undetermined'

export interface AiPriceProfile {
  profileId: string
  label: string
  modelId: string
  inputUsdPerMillionTokens: number
  cachedInputUsdPerMillionTokens: number
  outputUsdPerMillionTokens: number
  currency: 'USD'
  effectiveDate: string
  sourceUrl: string
}

export type AiTargetFetchStatus =
  | 'available'
  | 'unsupported_protocol'
  | 'pdf'
  | 'http_error'
  | 'non_html'
  | 'fetch_failed'

export interface AiSourceReference {
  linkResultKey: string
  pageUrl: string
}

export interface AiLinkSource {
  pageUrl: string
  /** 解決済みの元リンクURL。フラグメントを保持し、HTTP取得用URLとは区別する。 */
  linkUrl?: string
  urlFragment?: string
  isSamePageAnchor?: boolean
  linkText: string
  beforeText: string
  afterText: string
}

export interface AiTargetHeading {
  level: 1 | 2 | 3
  text: string
}

export interface AiAnchorTarget {
  fragment: string
  found: boolean
  targetId?: string
  heading?: AiTargetHeading
  surroundingText?: string
}

export interface AiLinkTarget {
  normalizedUrl: string
  finalUrl?: string
  title?: string
  headings: AiTargetHeading[]
  bodyExcerpt: string
  fetchStatus: AiTargetFetchStatus
  unavailableReason?: string
  anchor?: AiAnchorTarget
}

export interface AiMaskingSummary {
  ruleVersion: string
  maskedCount: number
  maskedCategories: string[]
  notice: string
}

export interface AiLinkInput {
  sequence: number
  itemId: string
  inputHash: string
  source: AiLinkSource
  sourceReferences: AiSourceReference[]
  target: AiLinkTarget
  masking: AiMaskingSummary
}

export interface AiInputBundleIntegrity {
  algorithm: 'HMAC-SHA256'
  payloadHash: string
  signature: string
}

export interface AiInputBundle {
  schemaVersion: 1
  kind: 'web-check-ai-input'
  contractVersion: string
  promptVersion: string
  bundleId: string
  projectId: string
  runId: string
  generatedAt: string
  contentTreatment: 'untrusted_data'
  items: AiLinkInput[]
  integrity: AiInputBundleIntegrity
}

export interface AiJudgment {
  itemId: string
  inputHash: string
  verdict: AiVerdict
  reason: string
  errorCode?: string
}

export interface AiOutputBundle {
  schemaVersion: 1
  kind: 'web-check-ai-output'
  contractVersion: string
  promptVersion: string
  projectId: string
  runId: string
  inputBundleId: string
  inputPayloadHash: string
  judge: {
    mode: Exclude<AiMode, 'off'>
    model?: string
  }
  judgments: AiJudgment[]
}

export type AiPreparationStatus =
  | 'disabled'
  | 'preparing'
  | 'input_ready'
  | 'awaiting_manual'
  | 'no_targets'
  | 'api_checking'
  | 'api_failed'
  | 'completed'
  | 'canceled'
  | 'interrupted'
  | 'preparation_failed'

export interface AiManualResult {
  output: AiOutputBundle
  importedAt: string
  outputHash: string
}

export interface AiApiResult {
  output: AiOutputBundle
  completedAt: string
  failedCount: number
}

export interface AiRunData {
  mode: AiMode
  status: AiPreparationStatus
  contractVersion: string
  promptVersion: string
  inputBundle?: AiInputBundle
  manualResult?: AiManualResult
  apiResult?: AiApiResult
  model?: string
  priceProfile?: AiPriceProfile
  error?: {
    code: string
    message: string
  }
}
