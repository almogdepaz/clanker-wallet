import { describe, it, expect } from 'vitest'
import { validateSign, MAX_SIGN_PAYLOAD_BYTES } from './sign.js'

const typed = { domain: { chainId: 1 }, types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Mail: [{ name: 'text', type: 'string' }] }, primaryType: 'Mail', message: { text: 'hello' } }

describe('signature validation before relay', () => {
  it('keeps text, raw bytes and parsed typed data exactly', () => {
    for (const message of ['hello 🌍', '0x00ff', '']) expect(validateSign(1, { method: 'personal_sign', message }).sign).toEqual({ method: 'personal_sign', message })
    expect(validateSign(1, { method: 'eth_signTypedData_v4', typed_data: typed }).sign).toEqual({ method: 'eth_signTypedData_v4', typed_data: typed })
  })
  it.each([0, 2, 999999, '1', NaN])('refuses unsupported chain %s', chain => {
    expect(() => validateSign(chain, { method: 'personal_sign', message: 'hello' })).toThrow(/supported EVM/)
  })
  it.each(['0x0', '0xzz', 5, null])('refuses malformed message %s', message => {
    expect(() => validateSign(1, { method: 'personal_sign', message })).toThrow(/message/)
  })
  it.each([
    JSON.stringify(typed),
    { ...typed, types: { Mail: [] } },
    { ...typed, primaryType: 'Missing' },
    { ...typed, domain: { chainId: 10 } },
    { ...typed, domain: { chainId: 'not a chain' } },
  ])('refuses malformed or mismatched typed data', typed_data => {
    expect(() => validateSign(1, { method: 'eth_signTypedData_v4', typed_data })).toThrow(/typed_data/)
  })
  it('refuses eth_sign and non-JSON values', () => {
    expect(() => validateSign(1, { method: 'eth_sign', message: '0x00' })).toThrow(/method/)
    expect(() => validateSign(1, { method: 'eth_signTypedData_v4', typed_data: { ...typed, message: { text: 1n } } })).toThrow(/JSON/)
  })
  it('caps compact JSON UTF-8 bytes, including hex and escaping', () => {
    expect(() => validateSign(1, { method: 'personal_sign', message: 'a'.repeat(MAX_SIGN_PAYLOAD_BYTES - 2) })).not.toThrow()
    for (const message of ['a'.repeat(MAX_SIGN_PAYLOAD_BYTES - 1), '🌍'.repeat(MAX_SIGN_PAYLOAD_BYTES / 4), '\n'.repeat(MAX_SIGN_PAYLOAD_BYTES / 2)]) {
      expect(() => validateSign(1, { method: 'personal_sign', message })).toThrow(/bytes/)
    }
  })
})
