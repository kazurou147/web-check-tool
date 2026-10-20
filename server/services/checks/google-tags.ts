import type { ExpectedGoogleTag, GoogleTagIdType } from '~/shared/types/excel-input'
import type {
  Finding,
  GoogleTagDetection,
  GoogleTagDetectionMethod,
  GoogleTagInstallationMethod,
  Verdict,
} from '~/shared/types/run'

const TAG_ID_PATTERN = /\b(?:GTM-[A-Z0-9]+|G-[A-Z0-9]+|AW-\d+|GT-[A-Z0-9]+|DC-\d+)\b/gi

export interface TagNetworkObservation {
  url: string
  initiatorUrls: string[]
}

export interface GoogleTagCheckInput {
  pageUrl: string
  pageNames: string[]
  sourceRows: number[]
  rawHtml: string
  renderedHtml: string
  network: TagNetworkObservation[]
  expected: ExpectedGoogleTag[]
}

export interface GoogleTagCheckResult {
  finding: Finding
  detections: GoogleTagDetection[]
}

interface HtmlInstallation {
  id: string
  location: 'head' | 'body' | 'unknown'
  role: 'loader' | 'config' | 'noscript' | 'other'
}

export function checkGoogleTags(input: GoogleTagCheckInput): GoogleTagCheckResult {
  const htmlInstallations = findHtmlInstallations(input.rawHtml)
  const direct = buildDirectDetections(input.pageUrl, htmlInstallations)
  const network = buildNetworkDetections(input.pageUrl, input.network)
  const renderedIds = extractIds(input.renderedHtml)
  const detections = mergeDetections([...direct, ...network])
  const directIds = new Set(direct.map(detection => detection.id))
  for (const detection of detections) {
    if (detection.detectionMethod === 'network' && directIds.has(detection.id)) {
      detection.installationMethod = 'direct'
    }
  }
  const detectedIds = new Set(detections.map(detection => detection.id))
  const expectedById = expectedMap(input.expected)
  const reasons: Array<{ verdict: Verdict; text: string }> = []

  for (const [id, expectedTags] of expectedById) {
    if (!detectedIds.has(id)) {
      reasons.push({ verdict: 'ng', text: `期待タグ ${id} を検出できませんでした。` })
      continue
    }
    if (id.startsWith('GTM-')) {
      const installations = htmlInstallations.filter(item => item.id === id)
      for (const expected of expectedTags) {
        if (expected.placement === 'head' && !installations.some(item => item.location === 'head' && item.role !== 'noscript')) {
          reasons.push({ verdict: 'needs_review', text: `${id} のhead用コードをhead内で確認できませんでした。` })
        }
        if (expected.placement === 'body' && !installations.some(item => item.location === 'body' && item.role === 'noscript')) {
          reasons.push({ verdict: 'needs_review', text: `${id} のbody用コードをbody内で確認できませんでした。` })
        }
      }
    }
  }

  for (const detection of detections) {
    const expected = expectedById.has(detection.id)
    if (detection.detectionMethod === 'html_direct' && !expected) {
      detection.verdict = 'ng'
      detection.verdictReason = '期待タグにないIDがHTMLへ直接設置されています。'
      reasons.push({ verdict: 'ng', text: `${detection.id} は想定外のHTML直接設置です。` })
    } else if (detection.detectionMethod === 'network' && detection.installationMethod === 'unknown') {
      detection.verdict = 'needs_review'
      detection.verdictReason = '通信だけでは設置方法を特定できません。'
      reasons.push({ verdict: 'needs_review', text: `${detection.id} は通信でのみ検出され、設置方法を特定できません。` })
    } else {
      detection.verdict = 'ok'
      detection.verdictReason = detection.detectionMethod === 'gtm_delivered'
        ? 'GTM経由の配信として検出しました。期待未登録だけではNGにしません。'
        : '期待タグまたは許容される配信方法として検出しました。'
    }
  }

  for (const detection of direct) {
    if (isImproperDuplicate(detection.id, htmlInstallations)) {
      const current = detections.find(item => item.key === detection.key)
      if (current) {
        current.verdict = 'ng'
        current.verdictReason = '同じタグがHTMLへ不適切に複数設置されています。'
      }
      reasons.push({ verdict: 'ng', text: `${detection.id} がHTMLへ不適切に複数設置されています。` })
    }
  }

  // Rendered DOMにしか存在しないIDは直接設置と断定せず、設置方法不明として残す。
  for (const id of renderedIds) {
    if (detectedIds.has(id)) continue
    const detection = createDetection(input.pageUrl, id, 'network', 'unknown', ['描画後DOMで検出（元HTML・通信の根拠なし）'], 1)
    detection.verdict = 'needs_review'
    detection.verdictReason = '描画後DOMだけでは直接設置かGTM経由かを特定できません。'
    detections.push(detection)
    reasons.push({ verdict: 'needs_review', text: `${id} は描画後DOMでのみ検出され、設置方法を特定できません。` })
  }

  linkRelatedDetections(detections)
  const expectedCount = expectedById.size
  const verdict = highestVerdict(reasons.map(reason => reason.verdict))
  const noTarget = expectedCount === 0 && reasons.length === 0
  return {
    detections,
    finding: {
      key: `${input.pageUrl}|google_tags`,
      item: 'google_tags',
      verdict: noTarget ? 'ok' : verdict,
      detailStatus: noTarget ? 'not_applicable' : verdict === 'ok' ? 'matched' : 'issues_found',
      url: input.pageUrl,
      pageNames: input.pageNames,
      sourceRows: input.sourceRows,
      expected: [...expectedById.keys()],
      actual: detections.map(({ id, detectionMethod, installationMethod }) => ({ id, detectionMethod, installationMethod })),
      message: noTarget
        ? 'Googleタグは検査対象外です。'
        : reasons.length > 0 ? reasons.map(reason => reason.text).join(' ') : 'Googleタグは仕様どおりです。',
      evidence: detections.flatMap(detection => detection.evidence),
    },
  }
}

function findHtmlInstallations(rawHtml: string): HtmlInstallation[] {
  const html = decodeHtmlEntities(rawHtml)
  const lower = html.toLowerCase()
  const headEnd = lower.indexOf('</head>')
  const bodyStart = lower.indexOf('<body')
  const units: Array<{ text: string; index: number; tag: string }> = []
  const tagPattern = /<(script|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>|<script\b[^>]*\/?>/gi
  for (const match of html.matchAll(tagPattern)) {
    units.push({ text: match[0], index: match.index, tag: match[1]?.toLowerCase() ?? 'script' })
  }
  return units.flatMap(unit => extractIds(unit.text).map(id => ({
    id,
    location: headEnd >= 0 && unit.index < headEnd
      ? 'head' as const
      : bodyStart >= 0 && unit.index >= bodyStart ? 'body' as const : 'unknown' as const,
    role: unit.tag === 'noscript'
      ? 'noscript' as const
      : /googletagmanager\.com\/(?:gtm\.js|gtag\/js)/i.test(unit.text)
        ? 'loader' as const
        : /(?:gtag\s*\(|dataLayer\.push|google_tag_manager)/i.test(unit.text)
          ? 'config' as const
          : 'other' as const,
  })))
}

function buildDirectDetections(pageUrl: string, installations: HtmlInstallation[]): GoogleTagDetection[] {
  const ids = [...new Set(installations.map(item => item.id))]
  return ids.map(id => {
    const items = installations.filter(item => item.id === id)
    const locations = [...new Set(items.map(item => item.location))]
    const detection = createDetection(
      pageUrl,
      id,
      'html_direct',
      'direct',
      items.map(item => `${item.location}内の${item.role}コード`),
      installationCount(id, items),
    )
    detection.location = locations.length === 1 ? locations[0] : 'unknown'
    return detection
  })
}

function buildNetworkDetections(pageUrl: string, observations: TagNetworkObservation[]): GoogleTagDetection[] {
  const records = new Map<string, { method: GoogleTagDetectionMethod; installation: GoogleTagInstallationMethod; evidence: string[] }>()
  for (const observation of observations) {
    for (const id of extractNetworkIds(observation.url)) {
      const deliveredByGtm = observation.initiatorUrls.some(url => /googletagmanager\.com\/gtm\.js/i.test(url))
      const key = `${id}|${deliveredByGtm ? 'gtm_delivered' : 'network'}`
      const current = records.get(key) ?? {
        method: deliveredByGtm ? 'gtm_delivered' : 'network',
        installation: deliveredByGtm ? 'gtm' : 'unknown',
        evidence: [],
      }
      current.evidence.push(`Google関連通信: ${safeEvidenceUrl(observation.url)}`)
      records.set(key, current)
    }
  }
  return [...records.entries()].map(([key, value]) => {
    const id = key.split('|')[0]!
    return createDetection(pageUrl, id, value.method, value.installation, value.evidence, value.evidence.length)
  })
}

function extractNetworkIds(value: string): string[] {
  const ids = new Set(extractIds(decodeURIComponentSafely(value)))
  try {
    const url = new URL(value)
    if (/doubleclick\.net$/i.test(url.hostname) || /\.doubleclick\.net$/i.test(url.hostname)) {
      const source = url.searchParams.get('src') ?? /[;?]src=(\d+)/i.exec(value)?.[1]
      if (source && /^\d+$/.test(source)) ids.add(`DC-${source}`)
    }
    const ads = /\/pagead\/(?:conversion|viewthroughconversion)\/(\d+)/i.exec(url.pathname)?.[1]
      ?? url.searchParams.get('google_conversion_id')
    if (ads && /^\d+$/.test(ads)) ids.add(`AW-${ads}`)
  } catch {
    // URL形式が不正な通信はブラウザ側で失敗するため、ここでは抽出済みIDだけを保持する。
  }
  return [...ids]
}

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function mergeDetections(input: GoogleTagDetection[]): GoogleTagDetection[] {
  const output = new Map<string, GoogleTagDetection>()
  for (const detection of input) {
    const existing = output.get(detection.key)
    if (!existing) output.set(detection.key, detection)
    else {
      existing.evidence = [...new Set([...existing.evidence, ...detection.evidence])]
      existing.occurrences += detection.occurrences
    }
  }
  return [...output.values()]
}

function createDetection(
  pageUrl: string,
  id: string,
  detectionMethod: GoogleTagDetectionMethod,
  installationMethod: GoogleTagInstallationMethod,
  evidence: string[],
  occurrences: number,
): GoogleTagDetection {
  return {
    key: `${pageUrl}|${id}|${detectionMethod}`,
    pageUrl,
    id,
    tagType: tagType(id),
    detectionMethod,
    installationMethod,
    evidence: [...new Set(evidence)],
    verdict: 'ok',
    verdictReason: '',
    relatedDetectionKeys: [],
    location: 'unknown',
    occurrences,
  }
}

function linkRelatedDetections(detections: GoogleTagDetection[]): void {
  for (const detection of detections) {
    detection.relatedDetectionKeys = detections
      .filter(candidate => candidate.id === detection.id && candidate.key !== detection.key)
      .map(candidate => candidate.key)
  }
}

function expectedMap(expected: ExpectedGoogleTag[]): Map<string, ExpectedGoogleTag[]> {
  const output = new Map<string, ExpectedGoogleTag[]>()
  for (const tag of expected) {
    for (const { id } of tag.ids) {
      const normalized = id.toUpperCase()
      output.set(normalized, [...(output.get(normalized) ?? []), tag])
    }
  }
  return output
}

function isImproperDuplicate(id: string, installations: HtmlInstallation[]): boolean {
  const items = installations.filter(item => item.id === id)
  if (id.startsWith('GTM-')) {
    const headCode = items.filter(item => item.location === 'head' && item.role !== 'noscript').length
    const bodyCode = items.filter(item => item.location === 'body' && item.role === 'noscript').length
    const invalid = items.filter(item => !(
      item.location === 'head' && item.role !== 'noscript'
      || item.location === 'body' && item.role === 'noscript'
    )).length
    return headCode > 1 || bodyCode > 1 || invalid > 0
  }
  return installationCount(id, items) > 1
}

function installationCount(id: string, items: HtmlInstallation[]): number {
  if (id.startsWith('GTM-')) return items.length
  const loaders = items.filter(item => item.role === 'loader').length
  const configs = items.filter(item => item.role !== 'loader').length
  return Math.max(loaders, configs)
}

function extractIds(value: string): string[] {
  return [...new Set((value.match(TAG_ID_PATTERN) ?? []).map(id => id.toUpperCase()))]
}

function decodeHtmlEntities(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&#45;', '-').replaceAll('&#x2d;', '-')
}

function tagType(id: string): GoogleTagIdType {
  if (id.startsWith('GTM-')) return 'gtm'
  if (id.startsWith('G-')) return 'ga4'
  if (id.startsWith('AW-')) return 'google_ads'
  if (id.startsWith('GT-')) return 'google_tag'
  return 'floodlight'
}

function safeEvidenceUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|auth|password|email|user/i.test(key)) url.searchParams.set(key, '[REDACTED]')
    }
    url.username = ''
    url.password = ''
    return url.href.slice(0, 2_048)
  } catch {
    return '[URLを記録できません]'
  }
}

function highestVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('ng')) return 'ng'
  if (verdicts.includes('needs_review')) return 'needs_review'
  if (verdicts.includes('unchecked')) return 'unchecked'
  return 'ok'
}
