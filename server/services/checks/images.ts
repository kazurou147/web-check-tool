import type { ImageDevice, ImageResult, ImageSourceKind, Verdict } from '~/shared/types/run'
import { redactUrl } from './links'

export interface CapturedImage {
  imageUrl: string
  sourceKind: ImageSourceKind
  location: string
  complete: boolean | null
  naturalWidth: number | null
  decoded: boolean | null
  networkError?: string
}

export function checkImages(
  pageUrl: string,
  device: ImageDevice,
  images: CapturedImage[],
  timedOut: boolean,
): ImageResult[] {
  return images.map((image, index) => {
    const { verdict, message, evidence } = imageVerdict(image, timedOut)
    return {
      key: `${pageUrl}|image|${device}|${index}|${image.imageUrl}`,
      pageUrl,
      device,
      imageUrl: redactUrl(image.imageUrl),
      sourceKind: image.sourceKind,
      location: image.location,
      verdict,
      message,
      evidence,
    }
  })
}

function imageVerdict(
  image: CapturedImage,
  timedOut: boolean,
): { verdict: Verdict; message: string; evidence: string[] } {
  if (image.networkError) {
    return {
      verdict: 'ng',
      message: '画像の通信エラーを確認しました。',
      evidence: [sanitizeEvidence(image.networkError)],
    }
  }
  if (image.decoded === false || (image.complete === true && image.naturalWidth === 0)) {
    return {
      verdict: 'ng',
      message: '画像のデコードまたは表示失敗を確認しました。',
      evidence: [`complete=${String(image.complete)}, naturalWidth=${String(image.naturalWidth)}, decoded=${String(image.decoded)}`],
    }
  }
  if (image.decoded === true || (image.complete === true && (image.naturalWidth ?? 0) > 0)) {
    return {
      verdict: 'ok',
      message: '画像の読み込みと表示を確認しました。',
      evidence: [`complete=${String(image.complete)}, naturalWidth=${String(image.naturalWidth)}, decoded=${String(image.decoded)}`],
    }
  }
  return {
    verdict: 'needs_review',
    message: timedOut
      ? '端末別の画像検査時間上限に達し、読み込み完了を特定できませんでした。'
      : '時間内に画像の読み込み状態を特定できませんでした。',
    evidence: [`complete=${String(image.complete)}, naturalWidth=${String(image.naturalWidth)}, decoded=${String(image.decoded)}`],
  }
}

function sanitizeEvidence(value: string): string {
  return value.replace(/((?:authorization|cookie|password|token|secret)\s*[:=])\s*\S+/gi, '$1[REDACTED]').slice(0, 1_000)
}
