/**
 * Bech32 / Bech32m decoding — a port of the BIP-173 / BIP-350 reference
 * implementation (github.com/sipa/bech32 ref/python/segwit_addr.py).
 * Used to check transfer recipients: bitcoin segwit addresses and chia
 * puzzle-hash addresses (bech32m, hrp xch / txch).
 */

export type Bech32Encoding = 'bech32' | 'bech32m'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32M_CONST = 0x2bc830a3
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >>> 25
    chk = (((chk & 0x1ffffff) << 5) ^ value) >>> 0
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk = (chk ^ GENERATOR[i]) >>> 0
    }
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const codes = Array.from(hrp, (c) => c.charCodeAt(0))
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)]
}

/** validate a bech32/bech32m string; returns its hrp, data (checksum stripped) and encoding */
export function bech32Decode(bech: string): { hrp: string; data: number[]; encoding: Bech32Encoding } | null {
  for (const c of bech) {
    const code = c.charCodeAt(0)
    if (code < 33 || code > 126) return null
  }
  if (bech.toLowerCase() !== bech && bech.toUpperCase() !== bech) return null
  const lower = bech.toLowerCase()
  const pos = lower.lastIndexOf('1')
  if (pos < 1 || pos + 7 > lower.length || lower.length > 90) return null
  const data: number[] = []
  for (const c of lower.slice(pos + 1)) {
    const d = CHARSET.indexOf(c)
    if (d === -1) return null
    data.push(d)
  }
  const hrp = lower.slice(0, pos)
  const check = polymod([...hrpExpand(hrp), ...data])
  const encoding: Bech32Encoding | null = check === 1 ? 'bech32' : check === BECH32M_CONST ? 'bech32m' : null
  if (!encoding) return null
  return { hrp, data: data.slice(0, -6), encoding }
}

/** general power-of-2 base conversion */
export function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0
  let bits = 0
  const ret: number[] = []
  const maxv = (1 << toBits) - 1
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1
  for (const value of data) {
    if (value < 0 || value >> fromBits) return null
    acc = ((acc << fromBits) | value) & maxAcc
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      ret.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits) ret.push((acc << (toBits - bits)) & maxv)
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null
  }
  return ret
}

/** decode a segwit address for the given hrp ('bc' mainnet, 'tb' testnet/signet) */
export function decodeSegwitAddress(hrp: string, addr: string): { version: number; program: number[] } | null {
  const decoded = bech32Decode(addr)
  if (!decoded || decoded.hrp !== hrp || decoded.data.length === 0) return null
  const [version, ...rest] = decoded.data
  const program = convertBits(rest, 5, 8, false)
  if (!program || program.length < 2 || program.length > 40) return null
  if (version > 16) return null
  if (version === 0 && program.length !== 20 && program.length !== 32) return null
  if ((version === 0) !== (decoded.encoding === 'bech32')) return null
  return { version, program }
}

/** decode a chia address (bech32m of a 32-byte puzzle hash) for the given hrp ('xch' / 'txch') */
export function decodeChiaAddress(hrp: string, addr: string): number[] | null {
  const decoded = bech32Decode(addr)
  if (!decoded || decoded.hrp !== hrp || decoded.encoding !== 'bech32m') return null
  const puzzleHash = convertBits(decoded.data, 5, 8, false)
  return puzzleHash && puzzleHash.length === 32 ? puzzleHash : null
}
