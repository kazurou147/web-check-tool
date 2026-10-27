export type InputIssueSeverity = 'warning' | 'fatal'

export type InputIssueCode =
  | 'missing_sheet'
  | 'invalid_header'
  | 'missing_url'
  | 'invalid_url'
  | 'no_valid_urls'
  | 'formula_cell'
  | 'merged_cells'
  | 'missing_tag_code'
  | 'unreadable_tag_code'

export interface InputIssue {
  code: InputIssueCode
  severity: InputIssueSeverity
  sheetName: string
  message: string
  row?: number
  column?: string
  cell?: string
  range?: string
}

export type ExpectationState = 'value' | 'blank' | 'formula'

export interface InputPageRow {
  sourceRow: number
  pageName: string | null
  displayName: string
  url: string
  normalizedUrl: string
  urlIdentity?: string
  expectedTitle: string | null
  expectedDescription: string | null
  titleState: ExpectationState
  descriptionState: ExpectationState
}

export interface DuplicateExpectation {
  state: 'unique' | 'blank_present' | 'conflict'
  values: string[]
}

export interface DuplicateUrlGroup {
  normalizedUrl: string
  urlIdentity?: string
  sourceRows: number[]
  pageNames: string[]
  titleExpectation: DuplicateExpectation
  descriptionExpectation: DuplicateExpectation
}

export type GoogleTagIdType = 'gtm' | 'ga4' | 'google_ads' | 'google_tag' | 'floodlight'
export type GoogleTagPlacement = 'head' | 'body' | 'unspecified'

export interface ExpectedGoogleTagId {
  id: string
  type: GoogleTagIdType
}

export interface ExpectedGoogleTag {
  sourceRow: number
  name: string | null
  code: string
  ids: ExpectedGoogleTagId[]
  placement: GoogleTagPlacement
}

export interface InputSnapshot {
  schemaVersion: 1
  sourceFileName: string
  sheetName: '納品前のチェック'
  tagSheetName: 'Googleタグ'
  canStart: boolean
  totalDataRows: number
  blankRows: number
  hiddenExcludedRows: number
  validRows: number
  uniqueUrlCount: number
  pageRows: InputPageRow[]
  invalidRows: InputIssue[]
  headerIssues: InputIssue[]
  formulaIssues: InputIssue[]
  mergeIssues: InputIssue[]
  tagIssues: InputIssue[]
  duplicateGroups: DuplicateUrlGroup[]
  expectedGoogleTags: ExpectedGoogleTag[]
}
