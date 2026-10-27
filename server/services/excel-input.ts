import ExcelJS, { type Cell, type Worksheet } from 'exceljs'
import { readAndValidateXlsx, validateXlsxArchive } from './xlsx-security'
import type {
  DuplicateExpectation,
  DuplicateUrlGroup,
  ExpectedGoogleTag,
  ExpectedGoogleTagId,
  GoogleTagPlacement,
  InputIssue,
  InputPageRow,
  InputSnapshot,
} from '~/shared/types/excel-input'

const PAGE_SHEET_NAME = '納品前のチェック' as const
const TAG_SHEET_NAME = 'Googleタグ' as const
const PAGE_HEADERS = ['ページ名', 'URL', 'title', 'description'] as const
const TAG_HEADERS = ['タグ名', '設置コード'] as const
const GOOGLE_TAG_ID_PATTERN = /\b(?:GTM-[A-Z0-9]+|G-[A-Z0-9]+|AW-\d+|GT-[A-Z0-9]+|DC-\d+)\b/gi

export async function readExcelInput(filePath: string, sourceFileName: string): Promise<InputSnapshot> {
  const workbook = new ExcelJS.Workbook()
  const bytes = await readAndValidateXlsx(filePath)
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer)
  return parseExcelWorkbook(workbook, sourceFileName)
}

export async function readExcelInputBuffer(buffer: ExcelJS.Buffer, sourceFileName = 'fixture.xlsx'): Promise<InputSnapshot> {
  validateXlsxArchive(buffer as unknown as Uint8Array)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  return parseExcelWorkbook(workbook, sourceFileName)
}

export function parseExcelWorkbook(workbook: ExcelJS.Workbook, sourceFileName: string): InputSnapshot {
  const headerIssues: InputIssue[] = []
  const invalidRows: InputIssue[] = []
  const formulaIssues: InputIssue[] = []
  const mergeIssues: InputIssue[] = []
  const tagIssues: InputIssue[] = []
  const pageRows: InputPageRow[] = []
  const expectedGoogleTags: ExpectedGoogleTag[] = []
  let totalDataRows = 0
  let blankRows = 0
  let hiddenExcludedRows = 0

  const pageSheet = workbook.getWorksheet(PAGE_SHEET_NAME)
  const tagSheet = workbook.getWorksheet(TAG_SHEET_NAME)

  if (!pageSheet) headerIssues.push(missingSheetIssue(PAGE_SHEET_NAME))
  if (!tagSheet) headerIssues.push(missingSheetIssue(TAG_SHEET_NAME))

  if (pageSheet) {
    headerIssues.push(...validateHeaders(pageSheet, PAGE_HEADERS))
    const lastDataRow = findLastContentRow(pageSheet, 4)
    totalDataRows = Math.max(0, lastDataRow - 1)
    mergeIssues.push(...findMergeIssues(pageSheet, lastDataRow))

    for (let rowNumber = 2; rowNumber <= lastDataRow; rowNumber += 1) {
      const row = pageSheet.getRow(rowNumber)
      if (row.hidden) {
        hiddenExcludedRows += 1
        continue
      }

      const cells = [1, 2, 3, 4].map(column => row.getCell(column))
      if (cells.every(isBlankCell)) {
        blankRows += 1
        continue
      }

      const pageNameCell = row.getCell(1)
      const urlCell = row.getCell(2)
      const titleCell = row.getCell(3)
      const descriptionCell = row.getCell(4)

      const pageNameFormula = isFormulaCell(pageNameCell)
      const urlFormula = isFormulaCell(urlCell)
      const titleFormula = isFormulaCell(titleCell)
      const descriptionFormula = isFormulaCell(descriptionCell)

      if (pageNameFormula) formulaIssues.push(formulaIssue(PAGE_SHEET_NAME, rowNumber, 'A', 'ページ名'))
      if (urlFormula) formulaIssues.push(formulaIssue(PAGE_SHEET_NAME, rowNumber, 'B', 'URL'))
      if (titleFormula) formulaIssues.push(formulaIssue(PAGE_SHEET_NAME, rowNumber, 'C', 'title'))
      if (descriptionFormula) formulaIssues.push(formulaIssue(PAGE_SHEET_NAME, rowNumber, 'D', 'description'))

      const pageName = pageNameFormula ? null : cellText(pageNameCell)
      const urlText = urlFormula ? null : cellText(urlCell)
      const title = titleFormula ? null : cellText(titleCell)
      const description = descriptionFormula ? null : cellText(descriptionCell)

      if (urlFormula) continue
      if (urlText === null) {
        invalidRows.push({
          code: 'missing_url',
          severity: 'warning',
          sheetName: PAGE_SHEET_NAME,
          row: rowNumber,
          column: 'B',
          cell: `B${rowNumber}`,
          message: `${rowNumber}行目はURLが空欄のため除外しました。`,
        })
        continue
      }

      const normalizedUrl = normalizeHttpUrl(urlText)
      if (!normalizedUrl) {
        invalidRows.push({
          code: 'invalid_url',
          severity: 'warning',
          sheetName: PAGE_SHEET_NAME,
          row: rowNumber,
          column: 'B',
          cell: `B${rowNumber}`,
          message: `${rowNumber}行目のURLは有効なHTTP/HTTPS URLではないため除外しました。`,
        })
        continue
      }

      pageRows.push({
        sourceRow: rowNumber,
        pageName,
        displayName: pageName ?? urlText,
        url: urlText,
        normalizedUrl,
        expectedTitle: title,
        expectedDescription: description,
        titleState: titleFormula ? 'formula' : title === null ? 'blank' : 'value',
        descriptionState: descriptionFormula ? 'formula' : description === null ? 'blank' : 'value',
      })
    }
  }

  if (tagSheet) {
    headerIssues.push(...validateHeaders(tagSheet, TAG_HEADERS))
    const lastTagRow = findLastContentRow(tagSheet, 2)
    mergeIssues.push(...findMergeIssues(tagSheet, lastTagRow))

    for (let rowNumber = 2; rowNumber <= lastTagRow; rowNumber += 1) {
      const nameCell = tagSheet.getRow(rowNumber).getCell(1)
      const codeCell = tagSheet.getRow(rowNumber).getCell(2)
      if (isBlankCell(nameCell) && isBlankCell(codeCell)) continue

      const nameFormula = isFormulaCell(nameCell)
      const codeFormula = isFormulaCell(codeCell)
      if (nameFormula) formulaIssues.push(formulaIssue(TAG_SHEET_NAME, rowNumber, 'A', 'タグ名'))
      if (codeFormula) {
        formulaIssues.push(formulaIssue(TAG_SHEET_NAME, rowNumber, 'B', '設置コード'))
        tagIssues.push({
          code: 'unreadable_tag_code',
          severity: 'warning',
          sheetName: TAG_SHEET_NAME,
          row: rowNumber,
          column: 'B',
          cell: `B${rowNumber}`,
          message: `${rowNumber}行目の設置コードは数式のため登録対象外です。`,
        })
        continue
      }

      const name = nameFormula ? null : cellText(nameCell)
      const code = cellText(codeCell)
      if (code === null) {
        tagIssues.push({
          code: 'missing_tag_code',
          severity: 'warning',
          sheetName: TAG_SHEET_NAME,
          row: rowNumber,
          column: 'B',
          cell: `B${rowNumber}`,
          message: `${rowNumber}行目は設置コードが空欄のため登録対象外です。`,
        })
        continue
      }

      const ids = extractGoogleTagIds(code)
      if (ids.length === 0) {
        tagIssues.push({
          code: 'unreadable_tag_code',
          severity: 'warning',
          sheetName: TAG_SHEET_NAME,
          row: rowNumber,
          column: 'B',
          cell: `B${rowNumber}`,
          message: `${rowNumber}行目の設置コードから対応するGoogleタグIDを抽出できませんでした。`,
        })
        continue
      }

      expectedGoogleTags.push({
        sourceRow: rowNumber,
        name,
        code,
        ids,
        placement: inferTagPlacement(name, code, ids),
      })
    }
  }

  if (pageSheet && pageRows.length === 0) {
    invalidRows.push({
      code: 'no_valid_urls',
      severity: 'fatal',
      sheetName: PAGE_SHEET_NAME,
      message: '有効なURLが1件もありません。',
    })
  }

  const duplicateGroups = buildDuplicateGroups(pageRows)
  const allIssues = [...headerIssues, ...invalidRows, ...formulaIssues, ...mergeIssues, ...tagIssues]

  return {
    schemaVersion: 1,
    sourceFileName,
    sheetName: PAGE_SHEET_NAME,
    tagSheetName: TAG_SHEET_NAME,
    canStart: !allIssues.some(issue => issue.severity === 'fatal'),
    totalDataRows,
    blankRows,
    hiddenExcludedRows,
    validRows: pageRows.length,
    uniqueUrlCount: new Set(pageRows.map(row => row.normalizedUrl)).size,
    pageRows,
    invalidRows,
    headerIssues,
    formulaIssues,
    mergeIssues,
    tagIssues,
    duplicateGroups,
    expectedGoogleTags,
  }
}

export function extractGoogleTagIds(code: string): ExpectedGoogleTagId[] {
  const uniqueIds = [...new Set((code.match(GOOGLE_TAG_ID_PATTERN) ?? []).map(id => id.toUpperCase()))]
  return uniqueIds.map(id => ({ id, type: googleTagType(id) }))
}

function validateHeaders(sheet: Worksheet, expected: readonly string[]): InputIssue[] {
  return expected.flatMap((header, index) => {
    const column = String.fromCharCode(65 + index)
    const cell = sheet.getCell(1, index + 1)
    const actual = isFormulaCell(cell) ? null : cellText(cell)
    if (actual === header) return []
    return [{
      code: 'invalid_header' as const,
      severity: 'fatal' as const,
      sheetName: sheet.name,
      row: 1,
      column,
      cell: `${column}1`,
      message: `${sheet.name}!${column}1 は「${header}」である必要があります（現在: ${actual ?? '空欄または数式'}）。`,
    }]
  })
}

function findLastContentRow(sheet: Worksheet, maxColumn: number): number {
  for (let rowNumber = sheet.rowCount; rowNumber >= 2; rowNumber -= 1) {
    const row = sheet.getRow(rowNumber)
    for (let column = 1; column <= maxColumn; column += 1) {
      if (!isBlankCell(row.getCell(column))) return rowNumber
    }
  }
  return 1
}

function findMergeIssues(sheet: Worksheet, lastDataRow: number): InputIssue[] {
  return (sheet.model.merges ?? []).map(range => {
    const [startAddress, endAddress = startAddress] = range.split(':')
    const start = decodeCellAddress(startAddress)
    const end = decodeCellAddress(endAddress)
    const affectsPageData = sheet.name === PAGE_SHEET_NAME
      && lastDataRow >= 2
      && start.col <= 4
      && end.col >= 1
      && start.row <= lastDataRow
      && end.row >= 2
    return {
      code: 'merged_cells' as const,
      severity: affectsPageData ? 'fatal' as const : 'warning' as const,
      sheetName: sheet.name,
      range,
      message: affectsPageData
        ? `${sheet.name}!${range} の結合セルがA2:D${lastDataRow}へ影響するため開始できません。`
        : `${sheet.name}!${range} に結合セルがあります。`,
    }
  })
}

function decodeCellAddress(address: string): { row: number; col: number } {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(address)
  if (!match) throw new Error(`不正なセル参照です: ${address}`)
  let col = 0
  for (const character of match[1].toUpperCase()) {
    col = col * 26 + character.charCodeAt(0) - 64
  }
  return { row: Number(match[2]), col }
}

function buildDuplicateGroups(rows: InputPageRow[]): DuplicateUrlGroup[] {
  const groups = new Map<string, InputPageRow[]>()
  for (const row of rows) {
    const group = groups.get(row.normalizedUrl) ?? []
    group.push(row)
    groups.set(row.normalizedUrl, group)
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([normalizedUrl, group]): DuplicateUrlGroup => ({
      normalizedUrl,
      sourceRows: group.map(row => row.sourceRow),
      pageNames: group.map(row => row.displayName),
      titleExpectation: summarizeExpectation(group.map(row => row.expectedTitle)),
      descriptionExpectation: summarizeExpectation(group.map(row => row.expectedDescription)),
    }))
}

function summarizeExpectation(values: Array<string | null>): DuplicateExpectation {
  const nonBlankValues = [...new Set(values.filter((value): value is string => value !== null))]
  if (nonBlankValues.length > 1) return { state: 'conflict', values: nonBlankValues }
  if (values.some(value => value === null)) return { state: 'blank_present', values: nonBlankValues }
  return { state: 'unique', values: nonBlankValues }
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function cellText(cell: Cell): string | null {
  const value = cell.value
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value === '' ? null : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if ('richText' in value) {
    const text = value.richText.map(part => part.text).join('')
    return text === '' ? null : text
  }
  if ('hyperlink' in value) {
    const text = value.text ?? value.hyperlink
    return text === '' ? null : text
  }
  if ('error' in value) return null
  return null
}

function isBlankCell(cell: Cell): boolean {
  if (isFormulaCell(cell)) return false
  return cellText(cell) === null
}

function isFormulaCell(cell: Cell): boolean {
  const value = cell.value
  return Boolean(value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value))
}

function formulaIssue(sheetName: string, row: number, column: string, label: string): InputIssue {
  return {
    code: 'formula_cell',
    severity: 'warning',
    sheetName,
    row,
    column,
    cell: `${column}${row}`,
    message: `${sheetName}!${column}${row} の${label}は数式のため、キャッシュ値を採用しません。`,
  }
}

function missingSheetIssue(sheetName: string): InputIssue {
  return {
    code: 'missing_sheet',
    severity: 'fatal',
    sheetName,
    message: `必須シート「${sheetName}」がありません。`,
  }
}

function googleTagType(id: string): ExpectedGoogleTagId['type'] {
  if (id.startsWith('GTM-')) return 'gtm'
  if (id.startsWith('G-')) return 'ga4'
  if (id.startsWith('AW-')) return 'google_ads'
  if (id.startsWith('GT-')) return 'google_tag'
  return 'floodlight'
}

function inferTagPlacement(name: string | null, code: string, ids: ExpectedGoogleTagId[]): GoogleTagPlacement {
  if (!ids.some(id => id.type === 'gtm')) return 'unspecified'
  const source = `${name ?? ''}\n${code}`.toLowerCase()
  if (source.includes('body用') || source.includes('<noscript') || source.includes('/ns.html')) return 'body'
  if (source.includes('head用') || source.includes('<script')) return 'head'
  return 'unspecified'
}
