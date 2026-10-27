import { describe, expect, it } from 'vitest'
import { isBlockedAddress, NetworkPolicy } from '~/server/services/network-policy'

describe('SSRF対策', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2002:7f00:1::'])('%sを拒否対象とする', (address) => {
    expect(isBlockedAddress(address)).toBe(true)
  })

  it('公開アドレスを許可する', () => {
    expect(isBlockedAddress('93.184.216.34')).toBe(false)
    expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false)
  })

  it('DNS解決後の私設IPを拒否し、案件別明示ホストだけ許可する', async () => {
    const lookup = async () => [{ address: '10.0.0.5', family: 4 }]
    await expect(new NetworkPolicy({ lookup }).assertUrl('https://internal.example/')).rejects.toThrow('ローカル・私設')
    await expect(new NetworkPolicy({ lookup, allowedPrivateHosts: ['internal.example'] }).assertUrl('https://internal.example/')).resolves.toBeInstanceOf(URL)
  })

  it('公開IPと禁止IPが混在するDNS応答を安全側で拒否する', async () => {
    const policy = new NetworkPolicy({ lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ] })
    await expect(policy.resolveUrl('https://mixed.example/')).rejects.toThrow('混在')
    await expect(new NetworkPolicy({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
      allowedPrivateHosts: ['mixed.example'],
    }).resolveUrl('https://mixed.example/')).rejects.toThrow('混在')
  })

  it('明示許可ホストを完全一致・末尾ドット正規化で扱い、類似ドメインは許可しない', async () => {
    const lookup = async () => [{ address: '10.0.0.5', family: 4 }]
    const policy = new NetworkPolicy({ lookup, allowedPrivateHosts: ['Internal.Example.'] })
    await expect(policy.resolveUrl('https://internal.example./')).resolves.toMatchObject({
      hostname: 'internal.example',
      selectedAddress: { address: '10.0.0.5', family: 4 },
    })
    await expect(policy.resolveUrl('https://internal.example.evil/')).rejects.toThrow('ローカル・私設')
  })

  it('IPv6の検証済みアドレスと既定ポートを返す', async () => {
    const policy = new NetworkPolicy({ lookup: async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }] })
    await expect(policy.resolveUrl('https://ipv6.example/path')).resolves.toMatchObject({
      hostname: 'ipv6.example',
      port: 443,
      selectedAddress: { family: 6 },
    })
  })

  it('DNS失敗と空応答を安全側で拒否する', async () => {
    await expect(new NetworkPolicy({ lookup: async () => { throw new Error('secret resolver detail') } }).resolveUrl('https://safe.example/')).rejects.toThrow('DNSでアクセス先を確認できません')
    await expect(new NetworkPolicy({ lookup: async () => [] }).resolveUrl('https://safe.example/')).rejects.toThrow('DNSでアクセス先を確認できません')
  })

  it('HTTP/HTTPS以外とURL内認証情報を拒否する', async () => {
    const policy = new NetworkPolicy({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] })
    await expect(policy.assertUrl('file:///etc/passwd')).rejects.toThrow('HTTP/HTTPS')
    await expect(policy.assertUrl('https://user:password@example.com/')).rejects.toThrow('認証情報')
  })
})
