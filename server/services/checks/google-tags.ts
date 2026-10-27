import type { ExpectedGoogleTag, GoogleTagIdType } from '~/shared/types/excel-input'
import type {
  Finding,
  GtmBodyPlacement,
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
  pageUrlIdentity?: string
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
  bodyPlacement?: GtmBodyPlacement
}

export const GTM_BODY_NORMAL_MAX_ELEMENT_POSITION = 3

export function checkGoogleTags(input: GoogleTagCheckInput): GoogleTagCheckResult {
  const htmlInstallations = findHtmlInstallations(input.rawHtml)
  const direct = buildDirectDetections(input.pageUrl, htmlInstallations)
  const directGoogleTagIds = new Set(direct.filter(item => item.id.startsWith('GT-')).map(item => item.id))
  const network = buildNetworkDetections(input.pageUrl, input.network, directGoogleTagIds)
  const renderedIds = extractIds(input.renderedHtml)
  const detections = mergeDetections([...direct, ...network])
  if (input.pageUrlIdentity) detections.forEach(detection => { detection.pageUrlIdentity = input.pageUrlIdentity })
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
      for (const installation of installations.filter(item => item.role === 'noscript')) {
        const placement = installation.bodyPlacement
        if (!placement || placement.status === 'unresolved') {
          reasons.push({ verdict: 'needs_review', text: `${id} のbody用コード位置を確定できませんでした。` })
        } else if (placement.status === 'nested') {
          reasons.push({ verdict: 'needs_review', text: `${id} のbody用コードがbody直下ではなく別要素内にネストされています。` })
        } else if (placement.status === 'too_far') {
          reasons.push({ verdict: 'needs_review', text: `${id} のbody用コードはbody直下の${placement.elementPosition}番目で、正常範囲（先頭${GTM_BODY_NORMAL_MAX_ELEMENT_POSITION}要素以内）から外れています。` })
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
        : detection.detectionMethod === 'google_tag_delivered'
          ? `HTMLへ直接設置されたGoogleタグ ${detection.sourceTagId} 経由の配信として検出しました。期待タグの設置判定とは別に評価しています。`
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
    if (input.pageUrlIdentity) detection.pageUrlIdentity = input.pageUrlIdentity
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
      actual: detections.map(({ id, detectionMethod, installationMethod, sourceTagId }) => ({ id, detectionMethod, installationMethod, sourceTagId })),
      message: noTarget
        ? 'Googleタグは検査対象外です。'
        : reasons.length > 0 ? reasons.map(reason => reason.text).join(' ') : 'Googleタグは仕様どおりです。',
      evidence: detections.flatMap(detection => detection.evidence),
    },
  }
}

export function findHtmlInstallations(rawHtml: string): HtmlInstallation[] {
  const html = decodeHtmlEntities(rawHtml)
  const lower = html.toLowerCase()
  const headEnd = lower.indexOf('</head>')
  const bodyStart = lower.indexOf('<body')
  const units: Array<{ text: string; index: number; tag: string }> = []
  const bodyPlacements = analyzeGtmBodyPlacements(html)
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
    ...(unit.tag === 'noscript' ? { bodyPlacement: bodyPlacements.get(unit.index) ?? unresolvedBodyPlacement(unit.index, html) } : {}),
  })))
}

function analyzeGtmBodyPlacements(html: string): Map<number, GtmBodyPlacement> {
  const placements = new Map<number, GtmBodyPlacement>()
  const body = /<body\b[^>]*>/i.exec(html)
  if (!body || body.index === undefined) return placements
  const bodyContentStart = body.index + body[0].length
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>/g
  tokenPattern.lastIndex = bodyContentStart
  const stack: string[] = []
  let directElementPosition = 0
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(html)) !== null) {
    const token = match[0]
    if (token.startsWith('<!--') || token.startsWith('<!')) continue
    const closing = /^<\//.test(token)
    const tag = /^<\/?\s*([A-Za-z][\w:-]*)/.exec(token)?.[1]?.toLowerCase()
    if (!tag) continue
    if (closing) {
      if (tag === 'body') break
      const index = stack.lastIndexOf(tag)
      if (index >= 0) stack.splice(index)
      continue
    }
    if (tag === 'body') continue
    const directBodyChild = stack.length === 0
    if (directBodyChild) directElementPosition += 1
    if (tag === 'noscript') {
      const sourceCharacterDistance = match.index - bodyContentStart
      placements.set(match.index, {
        directBodyChild,
        ...(directBodyChild ? { elementPosition: directElementPosition } : {}),
        sourceCharacterDistance,
        status: !directBodyChild
          ? 'nested'
          : directElementPosition === 1
            ? 'recommended'
            : directElementPosition <= GTM_BODY_NORMAL_MAX_ELEMENT_POSITION
              ? 'acceptable_not_first'
              : 'too_far',
      })
    }
    if ((tag === 'script' || tag === 'style') && !/\/\s*>$/.test(token)) {
      const closingPattern = new RegExp(`<\\/${tag}\\s*>`, 'ig')
      closingPattern.lastIndex = tokenPattern.lastIndex
      const closingMatch = closingPattern.exec(html)
      if (closingMatch) tokenPattern.lastIndex = closingPattern.lastIndex
      continue
    }
    const selfClosing = /\/\s*>$/.test(token) || voidElements.has(tag)
    if (!selfClosing) stack.push(tag)
  }
  return placements
}

function unresolvedBodyPlacement(index: number, html: string): GtmBodyPlacement {
  const body = /<body\b[^>]*>/i.exec(html)
  return {
    directBodyChild: false,
    sourceCharacterDistance: body?.index === undefined ? -1 : Math.max(0, index - (body.index + body[0].length)),
    status: 'unresolved',
  }
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
    if (id.startsWith('GTM-')) {
      detection.gtmBodyPlacements = items
        .filter(item => item.role === 'noscript' && item.bodyPlacement)
        .map(item => item.bodyPlacement!)
      for (const placement of detection.gtmBodyPlacements) {
        const position = placement.elementPosition === undefined ? '' : `body直下${placement.elementPosition}番目、`
        detection.evidence.push(`GTM body位置: ${position}状態=${placement.status}、body開始後の生文字距離=${placement.sourceCharacterDistance}`)
      }
    }
    return detection
  })
}

function buildNetworkDetections(
  pageUrl: string,
  observations: TagNetworkObservation[],
  directGoogleTagIds: Set<string>,
): GoogleTagDetection[] {
  const records = new Map<string, {
    method: GoogleTagDetectionMethod
    installation: GoogleTagInstallationMethod
    evidence: string[]
    sourceTagId?: string
    associationEvidence: string[]
  }>()
  for (const observation of observations) {
    for (const id of extractNetworkIds(observation.url)) {
      const gtmInitiator = observation.initiatorUrls.find(url => /googletagmanager\.com\/gtm\.js(?:[?#]|$)/i.test(url))
      const sourceGoogleTagId = observation.initiatorUrls
        .map(extractGoogleTagLoaderId)
        .find(candidate => candidate !== null && directGoogleTagIds.has(candidate))
      const method: GoogleTagDetectionMethod = gtmInitiator
        ? 'gtm_delivered'
        : sourceGoogleTagId ? 'google_tag_delivered' : 'network'
      const installation: GoogleTagInstallationMethod = gtmInitiator
        ? 'gtm'
        : sourceGoogleTagId ? 'google_tag' : 'unknown'
      const key = `${id}|${method}|${sourceGoogleTagId ?? ''}`
      const current = records.get(key) ?? {
        method,
        installation,
        evidence: [],
        sourceTagId: sourceGoogleTagId ?? undefined,
        associationEvidence: [],
      }
      current.evidence.push(`Google関連通信: ${safeEvidenceUrl(observation.url)}`)
      if (gtmInitiator) {
        current.associationEvidence.push(`通信initiatorでGTMコンテナローダーを確認: ${safeEvidenceUrl(gtmInitiator)}`)
      } else if (sourceGoogleTagId) {
        const loaderUrl = observation.initiatorUrls.find(url => extractGoogleTagLoaderId(url) === sourceGoogleTagId)
        if (loaderUrl) {
          current.associationEvidence.push(`通信initiatorでHTML直接設置済みGoogleタグ ${sourceGoogleTagId} のローダーを確認: ${safeEvidenceUrl(loaderUrl)}`)
        }
      }
      records.set(key, current)
    }
  }
  return [...records.entries()].map(([key, value]) => {
    const id = key.split('|')[0]!
    const detection = createDetection(pageUrl, id, value.method, value.installation, value.evidence, value.evidence.length)
    // 通信回数を正確に集約できるよう、同一URLの反復もJSONへ保持する。
    detection.evidence = value.evidence
    detection.sourceTagId = value.sourceTagId
    detection.associationEvidence = [...new Set(value.associationEvidence)]
    return detection
  })
}

function extractGoogleTagLoaderId(value: string): string | null {
  try {
    const url = new URL(value)
    if (!/^(?:www\.)?googletagmanager\.com$/i.test(url.hostname) || !/^\/gtag\/js$/i.test(url.pathname)) return null
    const id = url.searchParams.get('id')?.toUpperCase() ?? ''
    return /^GT-[A-Z0-9]+$/.test(id) ? id : null
  } catch {
    return null
  }
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
      .filter(candidate => candidate.key !== detection.key && (
        candidate.id === detection.id
        || candidate.sourceTagId === detection.id
        || detection.sourceTagId === candidate.id
      ))
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
    return url.href
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
