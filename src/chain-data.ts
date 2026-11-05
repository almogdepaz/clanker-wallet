import { TOKENS } from './tokens.js'
import { validateTx } from './validate.js'

/** Keyless public defaults; operators can supply keyed URLs without exposing them in tool results. */
export const DEFAULT_RPC_URLS: Readonly<Record<number, string>> = {
  1: 'https://ethereum-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  421614: 'https://sepolia-rollup.arbitrum.io/rpc',
  10: 'https://mainnet.optimism.io',
  11155420: 'https://sepolia.optimism.io',
  137: 'https://polygon-bor-rpc.publicnode.com',
  80002: 'https://polygon-amoy-bor-rpc.publicnode.com',
}
export interface ChainDataOptions {
  rpcUrls?: Readonly<Record<number, string>>
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}
export class ChainDataError extends Error {}

export function rpcUrlsFromJson(value: string | undefined): Record<number, string> | undefined {
  if (!value) return undefined
  try {
    const urls: unknown = JSON.parse(value)
    if (!urls || typeof urls !== 'object' || Array.isArray(urls)) throw new Error()
    for (const [chain, url] of Object.entries(urls)) {
      if (!/^[1-9][0-9]*$/.test(chain) || typeof url !== 'string' || !/^https?:$/.test(new URL(url).protocol)) throw new Error()
    }
    return urls as Record<number, string>
  } catch { throw new ChainDataError('invalid RPC URL map: expected JSON mapping chain ids to http(s) URLs') }
}

export async function evmRpc(chainId: number, method: string, params: unknown[], options: ChainDataOptions = {}): Promise<unknown> {
  const url = options.rpcUrls?.[chainId] ?? DEFAULT_RPC_URLS[chainId]
  if (!url) throw new ChainDataError(`no RPC configured for chain ${chainId}`)
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error()
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error()
    const body = await response.json() as { result?: unknown; error?: unknown }
    if (body.error || !Object.hasOwn(body, 'result')) throw new Error()
    return body.result
  } catch { throw new ChainDataError(`chain ${chainId} RPC read failed (${method})`) }
}

export interface TokenMetadata { address: string; symbol: string; decimals: number }

export function nativeSymbol(chainId: number): string {
  return chainId === 137 || chainId === 80002 ? 'POL' : 'ETH'
}

/** Read both fields for unlisted contracts. Never search a symbol or guess its precision. */
export async function resolveToken(chainId: number, token: unknown, options: ChainDataOptions = {}): Promise<TokenMetadata | null> {
  validateTx(chainId, { to: '0x' + '0'.repeat(40), value: '0' })
  if (token === undefined || (typeof token === 'string' && token.toUpperCase() === nativeSymbol(chainId))) return null
  if (typeof token !== 'string' || !token) throw new ChainDataError('invalid token: use a listed symbol or pass the contract address')
  const listed = TOKENS.find(t => t.chain_id === chainId && (t.address === token.toLowerCase() || t.symbol.toUpperCase() === token.toUpperCase()))
  if (listed) return listed
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new ChainDataError('unlisted symbol: pass the contract address; never search by symbol')
  const { transaction } = validateTx(chainId, { to: token, value: '0' })
  try {
    const call = (data: string) => evmRpc(chainId, 'eth_call', [{ to: transaction.to, data }, 'latest'], options)
    const [rawDecimals, rawSymbol] = await Promise.all([call('0x313ce567'), call('0x95d89b41')])
    const decimals = Number(abiUint(rawDecimals))
    if (decimals > 255) throw new Error()
    const symbol = abiSymbol(rawSymbol)
    return { address: transaction.to, decimals, symbol }
  } catch { throw new ChainDataError('token metadata unavailable: decimals() and symbol() must both answer; nothing was sent') }
}

export function abiUint(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ChainDataError('invalid uint256 RPC result')
  return BigInt(value)
}

function abiSymbol(value: unknown): string {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value) || value.length > 1026) throw new Error()
  const hex = value.slice(2)
  let bytes: string
  if (hex.length === 64) bytes = hex.replace(/(?:00)+$/, '') // legacy bytes32 symbol
  else {
    if (BigInt('0x' + hex.slice(0, 64)) !== 32n) throw new Error()
    const size = Number(BigInt('0x' + hex.slice(64, 128)))
    if (size < 1 || size > 128 || hex.length < 128 + Math.ceil(size / 32) * 64) throw new Error()
    bytes = hex.slice(128, 128 + size * 2)
  }
  const symbol = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes.match(/../g) ?? [], b => parseInt(b, 16)))
  if (!symbol.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(symbol)) throw new Error()
  return symbol
}

function decimalParts(amount: unknown): [string, string] {
  if (typeof amount !== 'string' || amount.length > 400 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amount)) throw new ChainDataError('invalid amount: use a positive human decimal string, not exponent notation')
  const [whole, fraction = ''] = amount.split('.')
  if (BigInt(whole + fraction) === 0n) throw new ChainDataError('amount must be positive')
  return [whole, fraction]
}

export function decimalUnits(amount: unknown, decimals: number): string {
  const [whole, fraction] = decimalParts(amount)
  if (fraction.length > decimals) throw new ChainDataError(`amount has more fraction digits than ${decimals}; refusing to round`)
  const raw = BigInt(whole + fraction.padEnd(decimals, '0'))
  if (raw <= 0n || raw >= 2n ** 256n) throw new ChainDataError('amount must be positive and fit uint256')
  return raw.toString()
}

export async function buildTokenTransfer(args: { chain_id: unknown; to: unknown; token?: unknown; amount: unknown }, options: ChainDataOptions = {}) {
  const { chain_id, transaction } = validateTx(args.chain_id, { to: args.to, value: '0' })
  decimalParts(args.amount) // refuse invalid/zero amounts before metadata I/O
  const token = await resolveToken(chain_id, args.token, options)
  const amount = decimalUnits(args.amount, token?.decimals ?? 18)
  return validateTx(chain_id, token ? {
    to: token.address, value: '0', data: '0xa9059cbb' + transaction.to.slice(2).toLowerCase().padStart(64, '0') + BigInt(amount).toString(16).padStart(64, '0'),
  } : { to: transaction.to, value: amount, data: '0x' })
}
