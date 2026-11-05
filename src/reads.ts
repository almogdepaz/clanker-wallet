import { decodeChiaAddress, decodeSegwitAddress } from './bech32.js'
import { abiUint, ChainDataError, evmRpc, nativeSymbol, resolveToken, type ChainDataOptions } from './chain-data.js'
import { validateTx } from './validate.js'

const BITCOIN_API: Record<string, string> = {
  mainnet: 'https://mempool.space/api', testnet: 'https://mempool.space/testnet/api', signet: 'https://mempool.space/signet/api',
}
const CHIA_API: Record<string, string> = { mainnet: 'https://api.coinset.org', testnet11: 'https://testnet11.api.coinset.org' }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChainDataError('malformed chain response')
  return value as Record<string, unknown>
}
const nonnegativeInteger = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ChainDataError('invalid chain integer')
  return value
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || value.length > 66) throw new ChainDataError('invalid RPC quantity')
  return BigInt(value)
}
function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0')
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : ''
  return (negative ? '-' : '') + (decimals ? digits.slice(0, -decimals) : digits) + (fraction ? '.' + fraction : '')
}
function network(args: Record<string, unknown>, endpoints: Record<string, string>): string {
  if (typeof args.network !== 'string' || !Object.hasOwn(endpoints, args.network)) throw new ChainDataError(`invalid network: must be ${Object.keys(endpoints).join(', ')}`)
  if (args.chain_id !== undefined || args.token !== undefined) throw new ChainDataError('chain_id and token are EVM-only')
  return args.network
}
async function http(url: string, options: ChainDataOptions, init?: RequestInit, allowMissing = false): Promise<Response> {
  try {
    const result = await (options.fetch ?? globalThis.fetch)(url, { ...init, signal: AbortSignal.timeout(10_000) })
    if (!result.ok && !(allowMissing && result.status === 404)) throw new Error()
    return result
  } catch { throw new ChainDataError('public chain API read failed; retry later') }
}
async function json(response: Response): Promise<unknown> {
  try { return await response.json() } catch { throw new ChainDataError('malformed chain JSON response') }
}

/** Validate legacy Base58Check as well as segwit recipients; no URL/path comes from the caller. */
async function bitcoinAddress(address: unknown, chainNetwork: string): Promise<string> {
  if (typeof address !== 'string' || address.length > 90) throw new ChainDataError('invalid bitcoin address')
  if (decodeSegwitAddress(chainNetwork === 'mainnet' ? 'bc' : 'tb', address)) return address.toLowerCase()
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  if (address.length < 26 || address.length > 35 || [...address].some(c => !alphabet.includes(c))) throw new ChainDataError('invalid bitcoin address for network')
  let value = 0n
  for (const c of address) value = value * 58n + BigInt(alphabet.indexOf(c))
  let hex = value.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const bytes = Uint8Array.from([...Array(address.match(/^1*/)?.[0].length ?? 0).fill(0), ...hex.match(/../g)!.map(b => parseInt(b, 16))])
  const versions = chainNetwork === 'mainnet' ? [0, 5] : [111, 196]
  if (bytes.length !== 25 || !versions.includes(bytes[0])) throw new ChainDataError('invalid bitcoin address for network')
  const first = await crypto.subtle.digest('SHA-256', bytes.slice(0, 21))
  const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', first))
  if (!bytes.slice(21).every((b, i) => b === checksum[i])) throw new ChainDataError('invalid bitcoin address checksum')
  return address
}

/** Preserve uint64 coin amounts using native JSON source context; older runtimes refuse unsafe numbers. */
function coinJson(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text, (_key, value, context?: { source?: string }) => {
      if (typeof value !== 'number') return value
      if (context?.source) return context.source
      if (Number.isSafeInteger(value)) return String(value)
      throw new Error('unsafe coin amount')
    }))
  } catch { throw new ChainDataError('malformed or imprecise coin-record response') }
}

export async function getBalance(args: Record<string, unknown>, options: ChainDataOptions = {}) {
  if (args.family === 'evm') {
    if (args.network !== undefined) throw new ChainDataError('EVM reads use chain_id, not network')
    const { chain_id, transaction } = validateTx(args.chain_id, { to: args.address, value: '0' })
    const token = await resolveToken(chain_id, args.token, options)
    const result = token
      ? await evmRpc(chain_id, 'eth_call', [{ to: token.address, data: '0x70a08231' + transaction.to.slice(2).toLowerCase().padStart(64, '0') }, 'latest'], options)
      : await evmRpc(chain_id, 'eth_getBalance', [transaction.to, 'latest'], options)
    const raw = token ? abiUint(result) : quantity(result)
    const decimals = token?.decimals ?? 18
    return { family: 'evm', chain_id, address: transaction.to, asset: token?.symbol ?? nativeSymbol(chain_id), ...(token && { token_address: token.address }), decimals, raw_balance: raw.toString(), balance: formatUnits(raw, decimals) }
  }
  if (args.family === 'bitcoin') {
    const chainNetwork = network(args, BITCOIN_API)
    const address = await bitcoinAddress(args.address, chainNetwork)
    const body = object(await json(await http(`${BITCOIN_API[chainNetwork]}/address/${encodeURIComponent(address)}`, options)))
    const stats = (field: string) => {
      const row = object(body[field])
      return BigInt(nonnegativeInteger(row.funded_txo_sum)) - BigInt(nonnegativeInteger(row.spent_txo_sum))
    }
    const confirmed = stats('chain_stats')
    const pending = stats('mempool_stats')
    if (confirmed < 0n || confirmed + pending < 0n) throw new ChainDataError('invalid bitcoin balance response')
    return { family: 'bitcoin', network: chainNetwork, address, asset: 'BTC', decimals: 8, raw_balance: String(confirmed + pending), balance: formatUnits(confirmed + pending, 8), confirmed_balance: formatUnits(confirmed, 8), unconfirmed_balance: formatUnits(pending, 8) }
  }
  if (args.family === 'chia') {
    const chainNetwork = network(args, CHIA_API)
    const puzzle = typeof args.address === 'string' && decodeChiaAddress(chainNetwork === 'mainnet' ? 'xch' : 'txch', args.address)
    if (!puzzle) throw new ChainDataError('invalid chia address for network')
    const puzzleHash = '0x' + puzzle.map(b => b.toString(16).padStart(2, '0')).join('')
    const response = await http(`${CHIA_API[chainNetwork]}/get_coin_records_by_puzzle_hash`, options, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ puzzle_hash: puzzleHash, include_spent_coins: false }),
    })
    const body = coinJson(await response.text())
    if (body.success !== true || !Array.isArray(body.coin_records)) throw new ChainDataError('coin-record API did not return a successful balance')
    let raw = 0n
    const seen = new Set<string>()
    for (const item of body.coin_records) {
      const record = object(item)
      if (record.spent === true) continue
      if (record.spent !== false) throw new ChainDataError('invalid coin-record spent flag')
      const coin = object(record.coin)
      if (coin.puzzle_hash !== puzzleHash || typeof coin.parent_coin_info !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(coin.parent_coin_info) || typeof coin.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(coin.amount) || coin.amount.length > 20) throw new ChainDataError('invalid coin-record identity or amount')
      const amount = BigInt(coin.amount)
      if (amount >= 2n ** 64n) throw new ChainDataError('coin amount exceeds uint64')
      const id = coin.parent_coin_info.toLowerCase() + ':' + coin.amount
      if (seen.has(id)) throw new ChainDataError('duplicate coin record')
      seen.add(id)
      raw += amount
    }
    return { family: 'chia', network: chainNetwork, address: args.address, asset: 'XCH', decimals: 12, raw_balance: raw.toString(), balance: formatUnits(raw, 12), scope: 'unspent coins at this puzzle hash; not the whole wallet; excludes mempool' }
  }
  throw new ChainDataError('invalid family: must be evm, bitcoin or chia')
}

export async function getTxStatus(args: Record<string, unknown>, options: ChainDataOptions = {}) {
  if (args.family === 'evm') {
    if (args.network !== undefined) throw new ChainDataError('EVM reads use chain_id, not network')
    const { chain_id } = validateTx(args.chain_id, { to: '0x' + '0'.repeat(40), value: '0' })
    if (typeof args.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(args.tx_hash)) throw new ChainDataError('invalid EVM tx_hash')
    const receipt = await evmRpc(chain_id, 'eth_getTransactionReceipt', [args.tx_hash], options)
    if (receipt === null) return { family: 'evm', chain_id, tx_hash: args.tx_hash, status: 'pending_or_unknown', confirmations: 0 }
    const row = object(receipt)
    if (row.status !== '0x0' && row.status !== '0x1') throw new ChainDataError('invalid receipt status')
    const height = quantity(row.blockNumber)
    const tip = quantity(await evmRpc(chain_id, 'eth_blockNumber', [], options))
    if (tip < height || tip - height >= BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainDataError('inconsistent receipt/block height; retry after chain reorganization')
    return { family: 'evm', chain_id, tx_hash: args.tx_hash, status: row.status === '0x1' ? 'confirmed' : 'failed', confirmations: Number(tip - height + 1n) }
  }
  if (args.family === 'bitcoin') {
    const chainNetwork = network(args, BITCOIN_API)
    if (typeof args.tx_hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(args.tx_hash)) throw new ChainDataError('invalid bitcoin tx_hash')
    const base = BITCOIN_API[chainNetwork]
    const response = await http(`${base}/tx/${args.tx_hash}/status`, options, undefined, true)
    const common = { family: 'bitcoin', network: chainNetwork, tx_hash: args.tx_hash }
    if (response.status === 404) return { ...common, status: 'unknown', confirmations: 0 }
    const row = object(await json(response))
    if (row.confirmed === false) return { ...common, status: 'pending', confirmations: 0 }
    if (row.confirmed !== true) throw new ChainDataError('invalid bitcoin transaction status')
    const height = nonnegativeInteger(row.block_height)
    const tipText = await (await http(`${base}/blocks/tip/height`, options)).text()
    if (!/^(0|[1-9][0-9]*)$/.test(tipText)) throw new ChainDataError('invalid bitcoin tip height')
    const tip = nonnegativeInteger(Number(tipText))
    if (tip < height) throw new ChainDataError('inconsistent bitcoin block height; retry')
    return { ...common, status: 'confirmed', confirmations: tip - height + 1 }
  }
  throw new ChainDataError('transaction status supports evm or bitcoin; after a chia send without a hash, use get_balance on the recipient')
}
