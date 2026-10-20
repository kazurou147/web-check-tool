import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class NetworkPolicyError extends Error {
  readonly code = 'NETWORK_POLICY_BLOCKED'
}

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export interface NetworkPolicyOptions {
  allowedPrivateHosts?: string[]
  lookup?: DnsLookup
}

export class NetworkPolicy {
  private readonly allowedPrivateHosts: Set<string>
  private readonly resolveHost: DnsLookup

  constructor(options: NetworkPolicyOptions = {}) {
    this.allowedPrivateHosts = new Set(
      (options.allowedPrivateHosts ?? []).map(normalizeHostname),
    )
    this.resolveHost = options.lookup ?? (async hostname => lookup(hostname, { all: true, verbatim: true }))
  }

  async assertUrl(value: string): Promise<URL> {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new NetworkPolicyError('URLの形式が不正です')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new NetworkPolicyError('HTTP/HTTPS以外のURLは取得できません')
    }
    if (url.username || url.password) {
      throw new NetworkPolicyError('認証情報を含むURLは取得できません')
    }

    const hostname = normalizeHostname(url.hostname)
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.resolveHost(hostname)
    if (addresses.length === 0) {
      throw new NetworkPolicyError('DNSでアクセス先を確認できません')
    }
    if (!this.allowedPrivateHosts.has(hostname)) {
      const blocked = addresses.find(entry => isBlockedAddress(entry.address))
      if (blocked) {
        throw new NetworkPolicyError(`ローカル・私設アドレスへのアクセスを拒否しました (${blocked.address})`)
      }
    }
    return url
  }
}

export function isBlockedAddress(input: string): boolean {
  const raw = input.toLowerCase().split('%')[0]!
  const value = isIP(raw) === 6
    ? new URL(`http://[${raw}]/`).hostname.replace(/^\[|\]$/g, '')
    : raw
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedAddress(mapped[1]!)
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1]!, 16)
    const low = Number.parseInt(mappedHex[2]!, 16)
    return isBlockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  if (isIP(value) === 4) return isBlockedIpv4(value)
  if (isIP(value) !== 6) return true

  if (value.startsWith('::')) return true // unspecified、loopback、IPv4互換/射影
  if (value.startsWith('64:ff9b:') || value.startsWith('64:ff9b:1:')) return true // IPv4変換
  if (value.startsWith('2001:0:')) return true // Teredo
  if (value.startsWith('2002:')) {
    const groups = value.split(':')
    const high = Number.parseInt(groups[1] ?? '0', 16)
    const low = Number.parseInt(groups[2] ?? '0', 16)
    if (isBlockedIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)) return true
  }
  const first = Number.parseInt(value.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 // fc00::/7
    || (first & 0xffc0) === 0xfe80 // fe80::/10
    || (first & 0xff00) === 0xff00 // multicast
    || value.startsWith('2001:db8:') // documentation
    || value === '2001:db8::'
}

function isBlockedIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  const [a, b, c] = parts
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a! >= 224
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}
