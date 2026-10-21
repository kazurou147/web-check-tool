export type AiMode = 'off' | 'manual' | 'api'
export type AiVerdict = 'match' | 'possible_mismatch' | 'undetermined'

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
  linkText: string
  beforeText: string
  afterText: string
}

export interface AiTargetHeading {
  level: 1 | 2 | 3
  text: string
}

export interface AiLinkTarget {
  normalizedUrl: string
  finalUrl?: string
  title?: string
  headings: AiTargetHeading[]
  bodyExcerpt: string
  fetchStatus: AiTargetFetchStatus
  unavailableReason?: string
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
  runId: string
  inputBundleId: string
  inputPayloadHash: string
  judge: {
    mode: Exclude<AiMode, 'off'>
    model?: string
  }
  judgments: AiJudgment[]
}

export type AiPreparationStatus = 'disabled' | 'preparing' | 'input_ready' | 'preparation_failed'

export interface AiRunData {
  mode: AiMode
  status: AiPreparationStatus
  contractVersion: string
  promptVersion: string
  inputBundle?: AiInputBundle
  error?: {
    code: string
    message: string
  }
}
