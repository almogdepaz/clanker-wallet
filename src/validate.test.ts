import { describe, it, expect } from 'vitest'
import { keccak256 } from './keccak.js'
import { InvalidTxError, isChecksumAddress, validateTx } from './validate.js'

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const utf8 = (s: string) => new TextEncoder().encode(s)

const TO = '0x000000000000000000000000000000000000dEaD'

/** the field validateTx rejects, or null if it accepts */
function rejectedField(chainId: unknown, tx: Record<string, unknown>): string | null {
  try {
    validateTx(chainId, tx)
    return null
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidTxError)
    return (err as InvalidTxError).field
  }
}

describe('keccak256', () => {
  // expected digests checked against viem's keccak256
  it.each([
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    // longer than one 136-byte block
    ['a'.repeat(200), '96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d'],
  ])('hashes %j', (input, digest) => {
    expect(hex(keccak256(utf8(input)))).toBe(digest)
  })
})

describe('isChecksumAddress', () => {
  it.each([
    // EIP-55 spec vectors
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
    '0xde709f2102306220921060314715629080e2fb77',
    '0x27b1fdb04752bbc536007a920d24acb045561c26',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ])('accepts %s', (address) => {
    expect(isChecksumAddress(address)).toBe(true)
  })

  it('rejects a mixed-case address with one flipped letter', () => {
    expect(isChecksumAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(false)
  })
})

describe('validateTx', () => {
  it('accepts a plain transfer and fills default data', () => {
    expect(validateTx(84532, { to: TO, value: '1000' })).toEqual({
      chain_id: 84532,
      transaction: { to: TO, value: '1000', data: '0x' },
    })
  })

  it('turns a bigint value into a decimal string', () => {
    expect(validateTx(1, { to: TO, value: 10n ** 18n, data: '0xabcd' }).transaction)
      .toEqual({ to: TO, value: '1000000000000000000', data: '0xabcd' })
  })

  it.each([0, -1, 1.5, NaN, '1', 2 ** 53])('rejects chain_id %j', (chainId) => {
    expect(rejectedField(chainId, { to: TO, value: '0' })).toBe('chain_id')
  })

  it.each([
    '0x...',
    '0xRecipient',
    TO.slice(0, -1),
    TO + '0',
    TO.slice(2),
    // bad EIP-55 checksum
    '0x000000000000000000000000000000000000dEAD',
    '',
    undefined,
    true,
  ])('rejects to %j', (to) => {
    expect(rejectedField(1, { to, value: '0' })).toBe('to')
  })

  it.each([TO.toLowerCase(), '0x000000000000000000000000000000000000DEAD'])('accepts single-case to %s', (to) => {
    expect(rejectedField(1, { to, value: '0' })).toBeNull()
  })

  it.each(['1.5', '-1', '1e18', '', ' 1', '0x10', 1, -1n, undefined])('rejects value %s', (value) => {
    expect(rejectedField(1, { to: TO, value })).toBe('value')
  })

  it.each([
    'abcd',
    '0xabc',
    '0xzz',
    // the SKILL.md erc-20 example from the prod e2e report: placeholder text inside the hex
    '0xa9059cbb000000000000000000000000RecipientAddr00000000000000000000000000000000000000000000000000000000000f4240',
    5,
  ])('rejects data %j', (data) => {
    expect(rejectedField(1, { to: TO, value: '0', data })).toBe('data')
  })

  it('names the field in the message', () => {
    expect(() => validateTx(1, { to: '0x...', value: '0' })).toThrow(/\bto\b.*0x\.\.\./)
  })
})
