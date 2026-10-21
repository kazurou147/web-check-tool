import type { AiMaskingSummary } from '~/shared/types/ai'

export const AI_MASKING_RULE_VERSION = '1.0.0'
export const AI_MASKING_NOTICE = '自動マスキングは、すべての個人情報や秘密情報の検出を保証するものではありません。外部判定前に内容を確認してください。'

export interface MaskedValue {
  value: string
  maskedCount: number
  maskedCategories: string[]
}

export class AiMaskingAccumulator {
  private count = 0
  private readonly categories = new Set<string>()

  text(value: string): string {
    const masked = maskSensitiveText(value)
    this.merge(masked)
    return masked.value
  }

  url(value: string): string {
    const masked = maskSensitiveUrl(value)
    this.merge(masked)
    return masked.value
  }

  summary(): AiMaskingSummary {
    return {
      ruleVersion: AI_MASKING_RULE_VERSION,
      maskedCount: this.count,
      maskedCategories: [...this.categories].sort(),
      notice: AI_MASKING_NOTICE,
    }
  }

  private merge(value: MaskedValue): void {
    this.count += value.maskedCount
    value.maskedCategories.forEach(category => this.categories.add(category))
  }
}

export function maskSensitiveUrl(value: string): MaskedValue {
  const tracker = createTracker()
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return maskSensitiveTextCore(value, false)
    if (url.username) {
      url.username = '[MASKED]'
      tracker.add('url_credentials')
    }
    if (url.password) {
      url.password = '[MASKED]'
      tracker.add('url_credentials')
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        const values = url.searchParams.getAll(key)
        url.searchParams.delete(key)
        values.forEach(() => {
          url.searchParams.append(key, '[MASKED]')
          tracker.add('url_query_secret')
        })
      }
    }
    return tracker.result(url.href)
  } catch {
    return maskSensitiveTextCore(value, false)
  }
}

export function maskSensitiveText(value: string): MaskedValue {
  return maskSensitiveTextCore(value, true)
}

function maskSensitiveTextCore(value: string, maskUrls: boolean): MaskedValue {
  const tracker = createTracker()
  let output = value

  if (maskUrls) {
    output = output.replace(/\bhttps?:\/\/[^\s<>"'|]+/giu, matched => {
      const trailing = matched.match(/[),.;!?。、「」』】]+$/u)?.[0] ?? ''
      const urlPart = trailing ? matched.slice(0, -trailing.length) : matched
      const masked = maskSensitiveUrl(urlPart)
      tracker.merge(masked)
      return `${masked.value}${trailing}`
    })
  }
  output = replace(output, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[MASKED_EMAIL]', 'email', tracker)
  output = replace(output, /(?:\+?\d[\d().\s-]{7,}\d)/gu, '[MASKED_PHONE]', 'phone', tracker)
  output = replace(output, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[MASKED_JWT]', 'jwt', tracker)
  output = replace(output, /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/gu, '[MASKED_API_KEY]', 'api_key', tracker)
  output = replace(
    output,
    /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/giu,
    '[MASKED_SECRET_HEADER]',
    'secret_header',
    tracker,
  )
  output = output.replace(
    /\b(token|api[_-]?key|secret|password|passwd|session(?:id)?)\s*[:=]\s*(?!\[MASKED|%5BMASKED%5D)([^\s,;]+)/giu,
    (_matched, key: string) => {
      tracker.add('named_secret')
      return `${key}=[MASKED_SECRET]`
    },
  )
  output = replace(
    output,
    /(?=\b[A-Za-z0-9+/_=-]{40,}\b)(?=[A-Za-z0-9+/_=-]*[A-Za-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]+/gu,
    '[MASKED_HIGH_ENTROPY]',
    'high_entropy',
    tracker,
  )

  return tracker.result(output)
}

function isSensitiveKey(value: string): boolean {
  return /(?:^|[_-])(?:token|key|secret|auth|authorization|password|passwd|session|sessionid|sid|cookie|email|user)(?:$|[_-])/iu.test(value)
}

function replace(
  value: string,
  pattern: RegExp,
  replacement: string,
  category: string,
  tracker: ReturnType<typeof createTracker>,
): string {
  return value.replace(pattern, () => {
    tracker.add(category)
    return replacement
  })
}

function createTracker() {
  let count = 0
  const categories = new Set<string>()
  return {
    add(category: string) {
      count += 1
      categories.add(category)
    },
    merge(value: MaskedValue) {
      count += value.maskedCount
      value.maskedCategories.forEach(category => categories.add(category))
    },
    result(value: string): MaskedValue {
      return { value, maskedCount: count, maskedCategories: [...categories].sort() }
    },
  }
}
