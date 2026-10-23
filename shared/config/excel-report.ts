export const REPORT_SHEET_NAMES = {
  summary: '検査サマリー',
  issues: 'NG・要確認一覧',
  all: '全検査結果',
} as const

export const REPORT_ALL_COLUMNS = [
  { key: 'url', header: 'URL', width: 42 },
  { key: 'pageName', header: 'ページ名', width: 24 },
  { key: 'sourceRows', header: '元行', width: 12 },
  { key: 'item', header: '項目', width: 20 },
  { key: 'displayVerdict', header: '判定', width: 12 },
  { key: 'problem', header: '問題', width: 42 },
  { key: 'expected', header: '期待値', width: 42 },
  { key: 'actual', header: '実測値', width: 42 },
  { key: 'device', header: '端末', width: 14 },
  { key: 'reference', header: '参照元', width: 34 },
  { key: 'date', header: '日時', width: 21 },
  { key: 'correctionStatus', header: '修正状況', width: 13 },
  { key: 'notes', header: '備考', width: 28 },
  { key: 'stableKey', header: '安定キー', width: 36 },
  { key: 'resultType', header: '結果種別', width: 28 },
  { key: 'detailStatus', header: '詳細状態', width: 24 },
  { key: 'difference', header: '差分', width: 52 },
  { key: 'evidence', header: '根拠', width: 52 },
  { key: 'aiModel', header: 'AIモデル', width: 20 },
] as const

export const REPORT_ISSUE_COLUMNS = [
  { key: 'displayVerdict', header: '判定', width: 12 },
  { key: 'pageName', header: 'ページ名', width: 24 },
  { key: 'item', header: '項目', width: 20 },
  { key: 'problem', header: '問題', width: 46 },
  { key: 'correctionStatus', header: '修正状況', width: 13 },
  { key: 'url', header: 'URL', width: 42 },
  { key: 'expected', header: '期待値', width: 48 },
  { key: 'actual', header: '実測値', width: 48 },
  { key: 'difference', header: '差分', width: 34 },
  { key: 'sourceRows', header: '元行', width: 12 },
  { key: 'device', header: '端末', width: 14 },
  { key: 'reference', header: '参照元', width: 34 },
  { key: 'date', header: '日時', width: 21 },
  { key: 'notes', header: '備考', width: 28 },
  { key: 'stableKey', header: '安定キー', width: 36 },
  { key: 'resultType', header: '結果種別', width: 28 },
  { key: 'detailStatus', header: '詳細状態', width: 24 },
  { key: 'evidence', header: '根拠', width: 58 },
  { key: 'aiModel', header: 'AIモデル', width: 20 },
] as const

// 後方互換用。全検査結果の既存列順を表す。
export const REPORT_DETAIL_COLUMNS = REPORT_ALL_COLUMNS

export type ReportDetailColumnKey = typeof REPORT_ALL_COLUMNS[number]['key']
export type ReportDetailColumn = { key: ReportDetailColumnKey; header: string; width: number }

export const REPORT_VERDICT_ORDER = {
  ng: 0,
  needs_review: 1,
  unchecked: 2,
  excluded: 3,
  ok: 4,
} as const

export const REPORT_VERDICT_COLORS = {
  ng: 'FFF4CCCC',
  needs_review: 'FFFFF2CC',
  unchecked: 'FFD9D9D9',
  excluded: 'FFF2F2F2',
  ok: 'FFD9EAD3',
} as const

export const REPORT_HEADER_COLOR = 'FF1F4E78'
export const REPORT_HEADER_TEXT_COLOR = 'FFFFFFFF'
export const REPORT_MAX_CELL_CHARACTERS = 32_767
export const REPORT_TRUNCATION_MARKER = '…[セル上限のため省略]'
export const REPORT_CORRECTION_STATUSES = ['未対応', '対応中', '修正済み'] as const
