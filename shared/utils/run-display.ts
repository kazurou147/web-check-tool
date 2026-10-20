import type { Finding, RunResult, RunStatus, Verdict } from '../types/run'

export const activeRunStatuses: readonly RunStatus[] = [
  'queued',
  'reading_input',
  'authenticating',
  'checking',
  'ai_checking',
]

export function isActiveRun(status: RunStatus): boolean {
  return activeRunStatuses.includes(status)
}

export function runProgress(result: RunResult): { completed: number; total: number; percent: number } {
  const total = result.input.uniqueUrlCount
  const completed = Math.min(result.pages.length, total)
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

const verdictPriority: Record<Verdict, number> = {
  ng: 0,
  needs_review: 1,
  unchecked: 2,
  ok: 3,
}

export function highestFindingVerdict(findings: Finding[]): Verdict {
  return [...findings].sort((left, right) => verdictPriority[left.verdict] - verdictPriority[right.verdict])[0]?.verdict ?? 'unchecked'
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => verdictPriority[left.verdict] - verdictPriority[right.verdict])
}

export type TextDiffKind = 'equal' | 'removed' | 'added'

export interface TextDiffSegment {
  kind: TextDiffKind
  text: string
}

export interface CharacterDetail {
  character: string | null
  display: string
  name: string
  codePoint: string
}

export interface TextDifference {
  matches: boolean
  expectedLength: number
  actualLength: number
  firstDifferencePosition: number | null
  expectedCharacter: CharacterDetail
  actualCharacter: CharacterDetail
  expectedSegments: TextDiffSegment[]
  actualSegments: TextDiffSegment[]
}

export function compareText(expected: string, actual: string): TextDifference {
  const expectedCharacters = Array.from(expected)
  const actualCharacters = Array.from(actual)
  let prefixLength = 0
  while (
    prefixLength < expectedCharacters.length
    && prefixLength < actualCharacters.length
    && expectedCharacters[prefixLength] === actualCharacters[prefixLength]
  ) {
    prefixLength += 1
  }

  const operations = diffCharacters(expectedCharacters, actualCharacters)
  return {
    matches: expected === actual,
    expectedLength: expectedCharacters.length,
    actualLength: actualCharacters.length,
    firstDifferencePosition: expected === actual ? null : prefixLength + 1,
    expectedCharacter: describeCharacter(expectedCharacters[prefixLength] ?? null),
    actualCharacter: describeCharacter(actualCharacters[prefixLength] ?? null),
    expectedSegments: groupOperations(operations.filter(operation => operation.kind !== 'added')),
    actualSegments: groupOperations(operations.filter(operation => operation.kind !== 'removed')),
  }
}

export function visibleText(value: string): string {
  return Array.from(value).map(character => describeCharacter(character).display).join('') || '（空文字）'
}

export function describeCharacter(character: string | null): CharacterDetail {
  if (character === null) {
    return { character: null, display: '∅', name: '文字なし', codePoint: '—' }
  }

  const invisibleCharacters: Record<string, { display: string; name: string }> = {
    ' ': { display: '␠', name: '半角スペース' },
    '　': { display: '□', name: '全角スペース' },
    '\n': { display: '↵\n', name: '改行（LF）' },
    '\r': { display: '␍', name: '復帰（CR）' },
    '\t': { display: '⇥', name: 'タブ' },
    '\u200b': { display: '⟦ゼロ幅⟧', name: 'ゼロ幅スペース' },
  }
  const codePoint = character.codePointAt(0) ?? 0
  const invisible = invisibleCharacters[character]
  return {
    character,
    display: invisible?.display ?? character,
    name: invisible?.name ?? '表示文字',
    codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
  }
}

interface CharacterOperation {
  kind: TextDiffKind
  character: string
}

function diffCharacters(expected: string[], actual: string[]): CharacterOperation[] {
  const rows = expected.length + 1
  const columns = actual.length + 1
  const commonLengths = Array.from({ length: rows }, () => new Uint32Array(columns))

  for (let expectedIndex = expected.length - 1; expectedIndex >= 0; expectedIndex -= 1) {
    for (let actualIndex = actual.length - 1; actualIndex >= 0; actualIndex -= 1) {
      commonLengths[expectedIndex]![actualIndex] = expected[expectedIndex] === actual[actualIndex]
        ? commonLengths[expectedIndex + 1]![actualIndex + 1]! + 1
        : Math.max(commonLengths[expectedIndex + 1]![actualIndex]!, commonLengths[expectedIndex]![actualIndex + 1]!)
    }
  }

  const operations: CharacterOperation[] = []
  let expectedIndex = 0
  let actualIndex = 0
  while (expectedIndex < expected.length || actualIndex < actual.length) {
    if (
      expectedIndex < expected.length
      && actualIndex < actual.length
      && expected[expectedIndex] === actual[actualIndex]
    ) {
      operations.push({ kind: 'equal', character: expected[expectedIndex]! })
      expectedIndex += 1
      actualIndex += 1
    } else if (
      expectedIndex < expected.length
      && (actualIndex >= actual.length || commonLengths[expectedIndex + 1]![actualIndex]! >= commonLengths[expectedIndex]![actualIndex + 1]!)
    ) {
      operations.push({ kind: 'removed', character: expected[expectedIndex]! })
      expectedIndex += 1
    } else {
      operations.push({ kind: 'added', character: actual[actualIndex]! })
      actualIndex += 1
    }
  }
  return operations
}

function groupOperations(operations: CharacterOperation[]): TextDiffSegment[] {
  const segments: TextDiffSegment[] = []
  for (const operation of operations) {
    const previous = segments.at(-1)
    if (previous?.kind === operation.kind) previous.text += operation.character
    else segments.push({ kind: operation.kind, text: operation.character })
  }
  return segments
}
