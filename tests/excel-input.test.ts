import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  extractGoogleTagIds,
  parseExcelWorkbook,
  readExcelInput,
  readExcelInputBuffer,
} from '~/server/services/excel-input'

describe('Excel入力処理', () => {
  it('web-check-origin.xlsxを読み取り、原本を変更しない', async () => {
    const sourcePath = resolve(process.cwd(), '..', 'web-check-origin.xlsx')
    const before = await readFile(sourcePath)
    const beforeHash = createHash('sha256').update(before).digest('hex')

    const snapshot = await readExcelInput(sourcePath, 'web-check-origin.xlsx')

    expect(snapshot.canStart).toBe(true)
    expect(snapshot.totalDataRows).toBe(4)
    expect(snapshot.validRows).toBe(4)
    expect(snapshot.uniqueUrlCount).toBe(4)
    expect(snapshot.blankRows).toBe(0)
    expect(snapshot.hiddenExcludedRows).toBe(0)
    expect(snapshot.duplicateGroups).toHaveLength(0)
    expect(snapshot.expectedGoogleTags).toHaveLength(3)
    expect(snapshot.pageRows[0].url).toBe('https://example.com/')
    expect(snapshot.pageRows[0].url).not.toContain('utm_source')
    expect(snapshot.expectedGoogleTags.map(tag => tag.placement)).toEqual(['head', 'body', 'unspecified'])

    const afterHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
    expect(afterHash).toBe(beforeHash)
  })

  it('空白、URL欠落、不正URL、数式、非表示行を仕様どおり分類する', () => {
    const workbook = validWorkbook()
    const sheet = workbook.getWorksheet('納品前のチェック')!
    sheet.addRow([])
    sheet.addRow(['URLなし'])
    sheet.addRow(['FTP', 'ftp://example.com/file'])
    const hidden = sheet.addRow(['非表示', 'https://hidden.example.com/'])
    hidden.hidden = true
    sheet.addRow(['重複1', 'https://EXAMPLE.com/path#one', 'Title A', ''])
    sheet.addRow(['重複2', 'https://example.com/path#two', 'Title B', 'Description'])
    sheet.addRow(['URL数式', { formula: '="https://formula.example.com/"', result: 'https://formula.example.com/' }])
    sheet.addRow([
      '期待値数式',
      'https://formula-fields.example.com/',
      { formula: '="cached title"', result: 'cached title' },
      { formula: '="cached description"', result: 'cached description' },
    ])
    sheet.addRow(['重複3', 'https://example.com/path', 'Title A', 'Description'])

    const snapshot = parseExcelWorkbook(workbook, 'fixture.xlsx')

    expect(snapshot.canStart).toBe(true)
    expect(snapshot.totalDataRows).toBe(9)
    expect(snapshot.blankRows).toBe(1)
    expect(snapshot.hiddenExcludedRows).toBe(1)
    expect(snapshot.validRows).toBe(4)
    expect(snapshot.invalidRows.map(issue => issue.code)).toEqual(['missing_url', 'invalid_url'])
    expect(snapshot.formulaIssues.map(issue => issue.cell)).toEqual(['B8', 'C9', 'D9'])
    expect(snapshot.pageRows.find(row => row.sourceRow === 9)).toMatchObject({
      expectedTitle: null,
      expectedDescription: null,
      titleState: 'formula',
      descriptionState: 'formula',
    })
    expect(snapshot.duplicateGroups).toEqual([expect.objectContaining({
      normalizedUrl: 'https://example.com/path',
      sourceRows: [6, 7, 10],
      titleExpectation: { state: 'conflict', values: ['Title A', 'Title B'] },
      descriptionExpectation: { state: 'blank_present', values: ['Description'] },
    })])
  })

  it('固定シートとヘッダーの欠落を開始不可にする', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('納品前のチェック')
    sheet.addRow(['ページ名', '間違ったURL見出し', 'title', 'description'])
    sheet.addRow(['トップ', 'https://example.com/'])

    const snapshot = parseExcelWorkbook(workbook, 'invalid-headers.xlsx')

    expect(snapshot.canStart).toBe(false)
    expect(snapshot.headerIssues.map(issue => issue.code)).toEqual(['missing_sheet', 'invalid_header'])
    expect(snapshot.headerIssues.some(issue => issue.cell === 'B1')).toBe(true)
  })

  it('有効URLが0件なら開始不可にする', () => {
    const workbook = validWorkbook()
    workbook.getWorksheet('納品前のチェック')!.addRow(['URLなし'])

    const snapshot = parseExcelWorkbook(workbook, 'no-valid-url.xlsx')

    expect(snapshot.canStart).toBe(false)
    expect(snapshot.invalidRows.some(issue => issue.code === 'no_valid_urls' && issue.severity === 'fatal')).toBe(true)
  })

  it('データ範囲へ影響する結合セルを致命的エラーにし、範囲外は警告にする', () => {
    const workbook = validWorkbook()
    const sheet = workbook.getWorksheet('納品前のチェック')!
    sheet.addRow(['結合', 'https://example.com/', 'Title', 'Description'])
    sheet.mergeCells('C2:D2')
    sheet.mergeCells('E1:F1')

    const snapshot = parseExcelWorkbook(workbook, 'merged.xlsx')

    expect(snapshot.canStart).toBe(false)
    expect(snapshot.mergeIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ range: 'C2:D2', severity: 'fatal' }),
      expect.objectContaining({ range: 'E1:F1', severity: 'warning' }),
    ]))
  })

  it('Googleタグの複数ID、位置、空欄、読取不能、数式を解析する', () => {
    const workbook = validWorkbook()
    const pageSheet = workbook.getWorksheet('納品前のチェック')!
    pageSheet.addRow(['トップ', 'https://example.com/'])
    const tagSheet = workbook.getWorksheet('Googleタグ')!
    tagSheet.addRow(['GTM body', '<noscript>GTM-ABC123</noscript>'])
    tagSheet.addRow(['複数', '<script>G-ABC123 AW-123456789 GT-XYZ999 DC-987654</script>'])
    tagSheet.addRow(['コードなし', ''])
    tagSheet.addRow(['不明', '<script>not-a-google-tag</script>'])
    tagSheet.addRow(['数式', { formula: '="G-RESULT123"', result: 'G-RESULT123' }])

    const snapshot = parseExcelWorkbook(workbook, 'tags.xlsx')

    expect(snapshot.expectedGoogleTags).toHaveLength(2)
    expect(snapshot.expectedGoogleTags[0]).toMatchObject({ placement: 'body' })
    expect(snapshot.expectedGoogleTags[1].ids.map(item => item.type)).toEqual([
      'ga4', 'google_ads', 'google_tag', 'floodlight',
    ])
    expect(snapshot.tagIssues.map(issue => issue.code)).toEqual([
      'missing_tag_code', 'unreadable_tag_code', 'unreadable_tag_code',
    ])
    expect(snapshot.formulaIssues.some(issue => issue.cell === 'B6')).toBe(true)
  })

  it('Googleタグの有効登録0件をエラーにしない', () => {
    const workbook = validWorkbook()
    workbook.getWorksheet('納品前のチェック')!.addRow(['トップ', 'https://example.com/'])

    const snapshot = parseExcelWorkbook(workbook, 'zero-tags.xlsx')

    expect(snapshot.canStart).toBe(true)
    expect(snapshot.expectedGoogleTags).toHaveLength(0)
  })

  it('HTTP/HTTPS以外を拒否し、フラグメントだけが違うURLを重複として扱う', () => {
    const workbook = validWorkbook()
    const sheet = workbook.getWorksheet('納品前のチェック')!
    sheet.addRow(['A', 'https://example.com/a#first', 'Same', 'Same'])
    sheet.addRow(['B', 'https://example.com/a#second', 'Same', 'Same'])
    sheet.addRow(['C', 'mailto:test@example.com'])

    const snapshot = parseExcelWorkbook(workbook, 'url-boundary.xlsx')

    expect(snapshot.uniqueUrlCount).toBe(1)
    expect(snapshot.duplicateGroups[0].titleExpectation).toEqual({ state: 'unique', values: ['Same'] })
    expect(snapshot.invalidRows.some(issue => issue.row === 4 && issue.code === 'invalid_url')).toBe(true)
  })

  it('ExcelJSが読み込んだhidden行をオートフィルター範囲内でも除外する', async () => {
    const workbook = validWorkbook()
    const sheet = workbook.getWorksheet('納品前のチェック')!
    sheet.addRow(['表示', 'https://visible.example.com/'])
    const filteredOut = sheet.addRow(['フィルター除外', 'https://filtered.example.com/'])
    filteredOut.hidden = true
    sheet.autoFilter = 'A1:D3'

    const serialized = await workbook.xlsx.writeBuffer()
    const snapshot = await readExcelInputBuffer(serialized, 'filtered.xlsx')

    expect(snapshot.hiddenExcludedRows).toBe(1)
    expect(snapshot.pageRows.map(row => row.url)).toEqual(['https://visible.example.com/'])
  })

  it('フィルター範囲だけでは行を推測除外しない', async () => {
    const workbook = validWorkbook()
    const sheet = workbook.getWorksheet('納品前のチェック')!
    sheet.addRow(['A', 'https://a.example.com/'])
    sheet.addRow(['B', 'https://b.example.com/'])
    sheet.autoFilter = 'A1:D3'

    const serialized = await workbook.xlsx.writeBuffer()
    const snapshot = await readExcelInputBuffer(serialized, 'filter-range-only.xlsx')

    expect(snapshot.hiddenExcludedRows).toBe(0)
    expect(snapshot.validRows).toBe(2)
  })

  it('対応するGoogleタグIDだけを大文字で重複なく抽出する', () => {
    expect(extractGoogleTagIds('g-abc123 G-ABC123 GT-XYZ AW-123 DC-456 GTM-CONTAINER')).toEqual([
      { id: 'G-ABC123', type: 'ga4' },
      { id: 'GT-XYZ', type: 'google_tag' },
      { id: 'AW-123', type: 'google_ads' },
      { id: 'DC-456', type: 'floodlight' },
      { id: 'GTM-CONTAINER', type: 'gtm' },
    ])
  })
})

function validWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook()
  const pageSheet = workbook.addWorksheet('納品前のチェック')
  pageSheet.addRow(['ページ名', 'URL', 'title', 'description'])
  const tagSheet = workbook.addWorksheet('Googleタグ')
  tagSheet.addRow(['タグ名', '設置コード'])
  return workbook
}
