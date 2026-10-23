import { decodeChiaAddress, decodeSegwitAddress } from './bech32.js'
import { keccak256 } from './keccak.js'
import type { Transaction, Transfer, TransferFamily, TransferInput, TxInput } from './types.js'

export type TxField = 'chain_id' | 'to' | 'value' | 'data' | 'chain_family' | 'chain_network' | 'asset' | 'amount' | 'fee'

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

const TRANSFER_ASSET: Record<TransferFamily, Transfer['asset']> = { bitcoin: 'btc', chia: 'xch' }

/** address hrp per network; the web app checks the same table */
const ADDRESS_HRP: Record<TransferFamily, Record<string, string>> = {
  bitcoin: { mainnet: 'bc', testnet: 'tb', signet: 'tb' },
  chia: { mainnet: 'xch', testnet11: 'txch' },
}

const NETWORK_NAMES: Record<TransferFamily, string> = {
  bitcoin: 'mainnet, testnet or signet',
  chia: 'mainnet or testnet11',
}

const POSITIVE_INT_RE = /^[1-9][0-9]*$/

/** a decimal string or bigint amount as a decimal string, or null */
function units(v: unknown, allowZero: boolean): string | null {
  if (typeof v === 'bigint') return v > 0n || (allowZero && v === 0n) ? v.toString() : null
  if (typeof v !== 'string') return null
  return POSITIVE_INT_RE.test(v) || (allowZero && v === '0') ? v : null
}

/**
 * check a bitcoin / chia transfer before anything is signed or sent, and normalize it
 * to the wire format (amounts as decimal strings, chia fee defaulting to "0").
 * the recipient must decode as an address on `chainNetwork`. as strict as the web app,
 * so a request it would refuse never leaves the agent. throws InvalidTxError.
 */
export function validateTransfer(
  chainFamily: unknown,
  chainNetwork: unknown,
  transfer: TransferInput | Record<string, unknown>,
): { chain_family: TransferFamily; chain_network: string; transfer: Transfer } {
  if (chainFamily !== 'bitcoin' && chainFamily !== 'chia') {
    throw new InvalidTxError('chain_family', `transfers need a bitcoin or chia pairing, got ${shown(chainFamily ?? 'evm')}`)
  }
  const family: TransferFamily = chainFamily
  const hrp = typeof chainNetwork === 'string' ? ADDRESS_HRP[family][chainNetwork] : undefined
  if (!hrp) throw new InvalidTxError('chain_network', `must be ${NETWORK_NAMES[family]}, got ${shown(chainNetwork)}`)
  const network = chainNetwork as string

  const asset = TRANSFER_ASSET[family]
  if (transfer.asset !== asset) throw new InvalidTxError('asset', `${family} transfers must be ${shown(asset)}, got ${shown(transfer.asset)}`)

  const unit = family === 'bitcoin' ? 'sats' : 'mojos'
  const amount = units(transfer.amount, false)
  if (!amount) throw new InvalidTxError('amount', `must be a positive integer amount of ${unit} (decimal string or bigint), got ${shown(transfer.amount)}`)

  const { to } = transfer
  if (family === 'bitcoin') {
    if (transfer.fee !== undefined) throw new InvalidTxError('fee', 'bitcoin transfers take no fee; the wallet sets it')
    // the wallet api takes sats as a js number
    if (BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new InvalidTxError('amount', `must be at most ${Number.MAX_SAFE_INTEGER} sats, got ${shown(amount)}`)
    }
    if (typeof to !== 'string' || !decodeSegwitAddress(hrp, to)) {
      throw new InvalidTxError('to', `not a bitcoin ${network} address (segwit, ${hrp}1...), got ${shown(to)}`)
    }
    return { chain_family: family, chain_network: network, transfer: { asset, to, amount } }
  }

  const fee = transfer.fee === undefined ? '0' : units(transfer.fee, true)
  if (!fee) throw new InvalidTxError('fee', `must be a non-negative integer amount of mojos (decimal string or bigint), got ${shown(transfer.fee)}`)
  if (typeof to !== 'string' || !decodeChiaAddress(hrp, to)) {
    throw new InvalidTxError('to', `not a chia ${network} address (${hrp}1...), got ${shown(to)}`)
  }
  return { chain_family: family, chain_network: network, transfer: { asset, to, amount, fee } }
}
