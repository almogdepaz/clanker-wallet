import { describe, it, expect } from 'vitest'
import {
  generateKeypair,
  decryptMessage,
  fromHex,
  signingKeypairFromSeed,
} from './crypto'

describe('decryptMessage input validation', () => {
  it('returns null for malformed base64 payload', () => {
    const sender = generateKeypair()
    const recipient = generateKeypair()

    expect(decryptMessage('%%%not-base64%%%', sender.publicKey, recipient.secretKey)).toBeNull()
  })
})

describe('fromHex validation', () => {
  it('strips 0x and 0X prefixes', () => {
    expect(fromHex('0xdeadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    expect(fromHex('0Xdeadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    expect(fromHex('0X')).toEqual(new Uint8Array())
  })

  it('throws for odd-length hex strings', () => {
    expect(() => fromHex('abc')).toThrow(/length must be even/)
    expect(() => fromHex('0xabc')).toThrow(/length must be even/)
  })

  it('throws for non-hex characters', () => {
    expect(() => fromHex('zz')).toThrow(/non-hex characters/)
    expect(() => fromHex('0xdeadbeeg')).toThrow(/non-hex characters/)
  })
})

describe('signingKeypairFromSeed validation', () => {
  it('throws when seed length is not 32 bytes', () => {
    expect(() => signingKeypairFromSeed(new Uint8Array(31))).toThrow(/expected 32 bytes/)
    expect(() => signingKeypairFromSeed(new Uint8Array(33))).toThrow(/expected 32 bytes/)
  })

  it('derives the same keypair after the caller mutates its seed buffer', () => {
    const seed = new Uint8Array(32).fill(7)
    const kp = signingKeypairFromSeed(seed)
    const publicKey = Uint8Array.from(kp.publicKey)
    seed.fill(0)
    expect(kp.publicKey).toEqual(publicKey)
    expect(signingKeypairFromSeed(new Uint8Array(32).fill(7)).publicKey).toEqual(publicKey)
  })
})
