import { describe, it, expect } from 'vitest'
import { bech32Decode, decodeChiaAddress, decodeSegwitAddress } from './bech32.js'

// test vectors from BIP-173 and BIP-350

const VALID_BECH32 = [
  'A12UEL5L',
  'a12uel5l',
  'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs',
  'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
  '11qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8247j',
  'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w',
  '?1ezyfcl',
]

const VALID_BECH32M = [
  'A1LQFN3A',
  'a1lqfn3a',
  'an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6',
  'abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx',
  '11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8',
  'split1checkupstagehandshakeupstreamerranterredcaperredlc445v',
  '?1v759aa',
]

const INVALID_BECH32 = [
  '\x201nwldj5',
  '\x7f1axkwrx',
  '\x801eym55h',
  'an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx',
  'pzry9x0s0muk',
  '1pzry9x0s0muk',
  'x1b4n0q5v',
  'li1dgmt3',
  'de1lg7wt\xff',
  'A1G7SGD8',
  '10a06t8',
  '1qzzfhee',
]

const INVALID_BECH32M = [
  '\x201xj0phk',
  '\x7f1g6xzxy',
  '\x801vctc34',
  'an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4',
  'qyrz8wqd2c9m',
  '1qyrz8wqd2c9m',
  'y1b0jsk6g',
  'lt1igcx5c0',
  'in1muywd',
  'mm1crxm3i',
  'au1s5cgom',
  'M1VUXWEZ',
  '16plkw9',
  '1p2gdwpf',
]

const VALID_SEGWIT: Array<[string, string]> = [
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', '0014751e76e8199196d454941c45d1b3a323f1433bd6'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262'],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', '5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6'],
  ['BC1SW50QGDZ25J', '6002751e'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', '5210751e76e8199196d454941c45d1b3a323'],
  ['tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy', '0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433'],
  ['tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'],
]

const INVALID_SEGWIT = [
  'tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
  'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf',
  'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL',
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh',
  'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47',
  'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4',
  'BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R',
  'bc1pw5dgrnzv',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav',
  'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P',
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf',
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j',
  'bc1gmk9yu',
]

/** scriptPubKey: OP_n (0x00 or 0x50+n), push length, program */
function scriptPubKey(version: number, program: number[]): string {
  const op = version === 0 ? 0 : version + 0x50
  return [op, program.length, ...program].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('bech32Decode (BIP-173 / BIP-350 vectors)', () => {
  it.each(VALID_BECH32)('accepts bech32 %s', (s) => {
    expect(bech32Decode(s)?.encoding).toBe('bech32')
  })

  it.each(VALID_BECH32M)('accepts bech32m %s', (s) => {
    expect(bech32Decode(s)?.encoding).toBe('bech32m')
  })

  it.each([...INVALID_BECH32, ...INVALID_BECH32M])('rejects %j', (s) => {
    expect(bech32Decode(s)).toBeNull()
  })
})

describe('decodeSegwitAddress (BIP-350 vectors)', () => {
  it.each(VALID_SEGWIT)('decodes %s', (addr, spk) => {
    const hrp = addr.slice(0, 2).toLowerCase()
    const decoded = decodeSegwitAddress(hrp, addr)
    expect(decoded).not.toBeNull()
    expect(scriptPubKey(decoded!.version, decoded!.program)).toBe(spk)
  })

  it.each(INVALID_SEGWIT)('rejects %s', (addr) => {
    expect(decodeSegwitAddress('bc', addr)).toBeNull()
    expect(decodeSegwitAddress('tb', addr)).toBeNull()
  })

  it('rejects a valid address under the other network hrp', () => {
    expect(decodeSegwitAddress('tb', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')).toBeNull()
  })
})

describe('decodeChiaAddress', () => {
  // puzzle hash 0x000102…1f, encoded with the reference implementation
  const PUZZLE_HASH = Array.from({ length: 32 }, (_, i) => i)
  const XCH = 'xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0srg6dkm'
  const TXCH = 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg'

  it('decodes mainnet and testnet puzzle hashes', () => {
    expect(decodeChiaAddress('xch', XCH)).toEqual(PUZZLE_HASH)
    expect(decodeChiaAddress('txch', TXCH)).toEqual(PUZZLE_HASH)
  })

  it('rejects the wrong network', () => {
    expect(decodeChiaAddress('xch', TXCH)).toBeNull()
    expect(decodeChiaAddress('txch', XCH)).toBeNull()
  })

  it('rejects bech32 (not m), wrong length and bad checksums', () => {
    expect(decodeChiaAddress('xch', 'xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sk52pne')).toBeNull()
    expect(decodeChiaAddress('xch', 'xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnlgaqhp')).toBeNull()
    expect(decodeChiaAddress('xch', XCH.slice(0, -1) + 'n')).toBeNull()
  })
})
