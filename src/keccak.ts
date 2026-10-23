/**
 * keccak-256 (the pre-NIST padding ethereum uses; NIST sha3-256 differs), only for
 * EIP-55 address checksums. inputs are a few dozen bytes, so lanes are plain bigints.
 */

const MASK64 = (1n << 64n) - 1n
const RATE_BYTES = 136

const rotl = (x: bigint, n: number): bigint =>
  n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64

// round constants from the degree-8 LFSR in the keccak reference
const ROUND_CONSTANTS: bigint[] = (() => {
  const out: bigint[] = []
  let r = 1
  for (let round = 0; round < 24; round++) {
    let rc = 0n
    for (let j = 0; j < 7; j++) {
      if (r & 1) rc |= 1n << BigInt((1 << j) - 1)
      r = r & 0x80 ? ((r << 1) ^ 0x71) & 0xff : (r << 1) & 0xff
    }
    out.push(rc)
  }
  return out
})()

// rho offsets, indexed by x + 5y
const ROTATIONS: number[] = (() => {
  const out = new Array<number>(25).fill(0)
  let x = 1
  let y = 0
  for (let t = 0; t < 24; t++) {
    out[x + 5 * y] = (((t + 1) * (t + 2)) / 2) % 64
    ;[x, y] = [y, (2 * x + 3 * y) % 5]
  }
  return out
})()

function keccakF(a: bigint[]): void {
  const b = new Array<bigint>(25)
  const c = new Array<bigint>(5)
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1)
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d
    }
    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROTATIONS[x + 5 * y])
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK64 & b[((x + 2) % 5) + y])
      }
    }
    // iota
    a[0] ^= ROUND_CONSTANTS[round]
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  // pad10*1 with keccak's 0x01 domain byte
  const padded = new Uint8Array(Math.floor(input.length / RATE_BYTES + 1) * RATE_BYTES)
  padded.set(input)
  padded[input.length] ^= 0x01
  padded[padded.length - 1] ^= 0x80

  const state = new Array<bigint>(25).fill(0n)
  for (let off = 0; off < padded.length; off += RATE_BYTES) {
    for (let i = 0; i < RATE_BYTES / 8; i++) {
      let lane = 0n
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k])
      state[i] ^= lane
    }
    keccakF(state)
  }

  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number((state[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn)
  return out
}
