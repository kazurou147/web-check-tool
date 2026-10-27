import type { ImageDevice, ImageResult, ImageSourceKind, Verdict } from '~/shared/types/run'
import { redactUrl } from './links'
import { createUrlIdentity } from '../url-identity'

export interface CapturedImage {
  imageUrl: string
  sourceKind: ImageSourceKind
  location: string
  currentSrc?: string
  complete: boolean | null
  naturalWidth: number | null
  naturalHeight?: number | null
  decoded: boolean | null
  visibility?: ImageVisibilityObservation
  networkError?: string
}

export interface ImageVisibilityObservation {
  clientRectCount: number
  layoutWidth: number
  layoutHeight: number
  hiddenAncestor?: string
  hiddenProperty?: 'display' | 'visibility' | 'content-visibility'
  hiddenValue?: string
  responsiveRule?: {
    selector: string
    mediaCondition: string
    stylesheet: string
  }
  interactiveRisk: boolean
  interactiveEvidence: string[]
}

export function checkImages(
  pageUrl: string,
  device: ImageDevice,
  images: CapturedImage[],
  timedOut: boolean,
  identityKey?: Uint8Array,
): ImageResult[] {
  return images.map((image, index) => {
    const { verdict, message, evidence, exclusion } = imageVerdict(image, device, timedOut)
    const pageUrlIdentity = identityKey ? optionalIdentity(pageUrl, identityKey) : undefined
    const imageUrlIdentity = identityKey ? optionalIdentity(image.imageUrl, identityKey) : undefined
    return {
      key: `${pageUrlIdentity ?? pageUrl}|image|${device}|${index}|${imageUrlIdentity ?? redactUrl(image.imageUrl)}`,
      pageUrl,
      ...(pageUrlIdentity ? { pageUrlIdentity } : {}),
      device,
      imageUrl: redactUrl(image.imageUrl),
      ...(imageUrlIdentity ? { imageUrlIdentity } : {}),
      sourceKind: image.sourceKind,
      location: image.location,
      verdict,
      message,
      evidence,
      ...(exclusion ? { exclusion } : {}),
    }
  })
}

function optionalIdentity(value: string, key: Uint8Array): string | undefined {
  try {
    return createUrlIdentity(value, key)
  } catch {
    return undefined
  }
}

function imageVerdict(
  image: CapturedImage,
  device: ImageDevice,
  timedOut: boolean,
): Pick<ImageResult, 'verdict' | 'message' | 'evidence' | 'exclusion'> {
  const stateEvidence = imageStateEvidence(image)
  if (image.networkError) {
    return {
      verdict: 'ng',
      message: '画像の通信エラーを確認しました。',
      evidence: [sanitizeEvidence(image.networkError), ...stateEvidence],
    }
  }
  if (image.decoded === false || (image.complete === true && image.naturalWidth === 0)) {
    return {
      verdict: 'ng',
      message: '画像のデコードまたは表示失敗を確認しました。',
      evidence: stateEvidence,
    }
  }
  const exclusion = responsiveImageExclusion(image, device)
  if (exclusion) {
    return {
      verdict: 'excluded',
      message: exclusion.reason,
      evidence: [
        ...stateEvidence,
        `非表示要素: ${exclusion.hiddenBy}`,
        `適用CSS: ${exclusion.cssSelector} { ${image.visibility?.hiddenProperty}: ${image.visibility?.hiddenValue} }`,
        `media query: ${exclusion.mediaCondition}`,
        `stylesheet: ${image.visibility?.responsiveRule?.stylesheet ?? '不明'}`,
      ],
      exclusion,
    }
  }
  if (image.decoded === true || (image.complete === true && (image.naturalWidth ?? 0) > 0)) {
    return {
      verdict: 'ok',
      message: '画像の読み込みと表示を確認しました。',
      evidence: stateEvidence,
    }
  }
  return {
    verdict: 'needs_review',
    message: timedOut
      ? '端末別の画像検査時間上限に達し、読み込み完了を特定できませんでした。'
      : '時間内に画像の読み込み状態を特定できませんでした。',
    evidence: [
      ...stateEvidence,
      ...(image.visibility?.interactiveEvidence ?? []),
    ],
  }
}

export function responsiveImageExclusion(
  image: CapturedImage,
  device: ImageDevice,
): ImageResult['exclusion'] | undefined {
  const visibility = image.visibility
  if (
    !visibility
    || visibility.clientRectCount !== 0
    || visibility.layoutWidth !== 0
    || visibility.layoutHeight !== 0
    || !visibility.hiddenAncestor
    || !visibility.hiddenProperty
    || !visibility.hiddenValue
    || !visibility.responsiveRule
    || visibility.interactiveRisk
  ) return undefined

  const label = device === 'mobile' ? 'スマートフォン' : 'PC'
  return {
    reason: `${label}ではレスポンシブCSSにより${visibility.hiddenAncestor}が非表示のため、画像読み込み検査の対象外としました。`,
    hiddenBy: visibility.hiddenAncestor,
    cssSelector: visibility.responsiveRule.selector,
    mediaCondition: visibility.responsiveRule.mediaCondition,
  }
}

function imageStateEvidence(image: CapturedImage): string[] {
  const evidence = [
    `currentSrc=${image.currentSrc || '（空）'}, complete=${String(image.complete)}, naturalWidth=${String(image.naturalWidth)}, naturalHeight=${String(image.naturalHeight ?? null)}, decoded=${String(image.decoded)}`,
  ]
  if (image.visibility) {
    evidence.push(`clientRects=${image.visibility.clientRectCount}, layout=${image.visibility.layoutWidth}x${image.visibility.layoutHeight}`)
  }
  return evidence
}

function sanitizeEvidence(value: string): string {
  return value.replace(/((?:authorization|cookie|password|token|secret)\s*[:=])\s*\S+/gi, '$1[REDACTED]').slice(0, 1_000)
}
