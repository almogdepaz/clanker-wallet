import { keccak256 } from './keccak.js'
import type { Transaction, TxInput } from './types.js'

export type TxField = 'chain_id' | 'to' | 'value' | 'data'

/** a tx request field failed validation; nothing was sent */
export class InvalidTxError extends Error {
  constructor(readonly field: TxField, readonly reason: string) {
    super(`invalid ${field}: ${reason}`)
    this.name = 'InvalidTxError'
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const DECIMAL_RE = /^[0-9]+$/
const CALLDATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/

/** short, quoted rendering of a rejected input for error messages */
function shown(v: unknown): string {
  const s = typeof v === 'bigint' ? `${v}n` : JSON.stringify(v) ?? String(v)
  return s.length > 70 ? `${s.slice(0, 67)}...` : s
}

/** EIP-55: a mixed-case address must carry the checksum; single-case addresses are unchecksummed */
export function isChecksumAddress(address: string): boolean {
  if (!ADDRESS_RE.test(address)) return false
  const body = address.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true
  const lower = body.toLowerCase()
  const hash = keccak256(new TextEncoder().encode(lower))
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf
    const expected = nibble >= 8 ? lower[i].toUpperCase() : lower[i]
    if (body[i] !== expected) return false
  }
  return true
}

/**
 * check a tx request before anything is signed or sent, and normalize it to the wire
 * format (value as a decimal wei string, data defaulting to "0x").
 * throws InvalidTxError naming the first bad field.
 */
export function validateTx(chainId: unknown, tx: TxInput | Record<string, unknown>): { chain_id: number; transaction: Transaction } {
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new InvalidTxError('chain_id', `must be a positive integer, got ${shown(chainId)}`)
  }

  const { to, value, data = '0x' } = tx
  if (typeof to !== 'string' || !ADDRESS_RE.test(to)) {
    throw new InvalidTxError('to', `must be 0x followed by 40 hex characters, got ${shown(to)}`)
  }
  if (!isChecksumAddress(to)) {
    throw new InvalidTxError('to', `mixed-case address fails its EIP-55 checksum, got ${shown(to)}`)
  }

  let wei: string
  if (typeof value === 'bigint' && value >= 0n) wei = value.toString()
  else if (typeof value === 'string' && DECIMAL_RE.test(value)) wei = value
  else throw new InvalidTxError('value', `must be a non-negative integer amount of wei (decimal string or bigint), got ${shown(value)}`)

  if (typeof data !== 'string' || !CALLDATA_RE.test(data)) {
    throw new InvalidTxError('data', `must be 0x followed by an even number of hex characters, got ${shown(data)}`)
  }

  return { chain_id: chainId, transaction: { to, value: wei, data } }
}
