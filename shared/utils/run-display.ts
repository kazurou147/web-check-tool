import type { Finding, ImageResult, RunResult, RunStatus, Verdict } from '../types/run'

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

export function canCancelRun(status: RunStatus, canceling: boolean): boolean {
  return isActiveRun(status) && !canceling
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
  excluded: 3,
  ok: 4,
}

export function highestFindingVerdict(findings: Finding[]): Verdict {
  return [...findings].sort((left, right) => verdictPriority[left.verdict] - verdictPriority[right.verdict])[0]?.verdict ?? 'unchecked'
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => verdictPriority[left.verdict] - verdictPriority[right.verdict])
}

export function imageVerdictCounts(images: ImageResult[]) {
  return {
    ng: images.filter(image => image.verdict === 'ng').length,
    needsReview: images.filter(image => image.verdict === 'needs_review').length,
    unchecked: images.filter(image => image.verdict === 'unchecked').length,
    excluded: images.filter(image => image.verdict === 'excluded').length,
    ok: images.filter(image => image.verdict === 'ok').length,
  }
}

const GOOGLE_NETWORK_EVIDENCE_PREFIX = 'Google関連通信: '

export interface GoogleNetworkEvidenceGroup {
  key: string
  hosts: string[]
  path: string
  detectedId: string
  eventName: string | null
  sendTo: string | null
  occurrences: number
  urls: string[]
}

export interface GoogleEvidenceSummary {
  notes: string[]
  networkGroups: GoogleNetworkEvidenceGroup[]
}

export function summarizeGoogleEvidence(evidence: string[], fallbackId: string): GoogleEvidenceSummary {
  const notes: string[] = []
  const groups = new Map<string, GoogleNetworkEvidenceGroup>()
  for (const item of evidence) {
    if (!item.startsWith(GOOGLE_NETWORK_EVIDENCE_PREFIX)) {
      notes.push(item)
      continue
    }
    const rawUrl = item.slice(GOOGLE_NETWORK_EVIDENCE_PREFIX.length)
    try {
      const url = new URL(rawUrl)
      const detectedId = url.searchParams.get('tid') ?? url.searchParams.get('id') ?? fallbackId
      const eventName = url.searchParams.get('en')
      const sendTo = url.searchParams.get('send_to')
      const key = [url.pathname, detectedId, eventName ?? '', sendTo ?? ''].join('|')
      const group = groups.get(key) ?? {
        key,
        hosts: [],
        path: url.pathname,
        detectedId,
        eventName,
        sendTo,
        occurrences: 0,
        urls: [],
      }
      if (!group.hosts.includes(url.hostname)) group.hosts.push(url.hostname)
      group.occurrences += 1
      if (!group.urls.includes(rawUrl)) group.urls.push(rawUrl)
      groups.set(key, group)
    } catch {
      notes.push(item)
    }
  }
  return { notes, networkGroups: [...groups.values()] }
}

export async function copyGoogleNetworkUrl(
  url: string,
  write?: (value: string) => Promise<void>,
): Promise<void> {
  if (write) {
    await write(url)
    return
  }
  try {
    await navigator.clipboard.writeText(url)
    return
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = url
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) throw new Error('URLをコピーできませんでした。')
  }
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
