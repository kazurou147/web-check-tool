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

  it('HTTP/HTTPS以外とURL内認証情報を拒否する', async () => {
    const policy = new NetworkPolicy({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] })
    await expect(policy.assertUrl('file:///etc/passwd')).rejects.toThrow('HTTP/HTTPS')
    await expect(policy.assertUrl('https://user:password@example.com/')).rejects.toThrow('認証情報')
  })
})
