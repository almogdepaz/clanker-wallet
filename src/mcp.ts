import { getBalance, getTxStatus } from './reads.js'
import { X402Error, X402_APPROVAL_MS, validateX402Fetch, fetchX402, prepareX402, retryX402, x402HttpResult, type X402HttpResult } from './x402.js'
import { buildTokenTransfer, ChainDataError, rpcUrlsFromJson, type ChainDataOptions } from './chain-data.js'
import { validateSign } from './sign.js'
import { RelayError, type ClankerWallet } from './client.js'
import type { TxContext } from './types.js'
import { InvalidTxError, validateTransfer, validateTx } from './validate.js'

/**
 * MCP server for `clanker-wallet mcp`: newline-delimited JSON-RPC 2.0 over stdio, hand-written so
 * tweetnacl stays the only runtime dependency. the cli owns stdin/stdout and the identity and pairing
 * files; this module answers one line at a time and keeps each request's state in memory.
 */

/** newest first; a client asking for another version gets the newest. not 2025-03-26: it requires receiving batches, which we refuse */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05']

/** get_request waits at most this long per call; assistants time tool calls out after about a minute */
export const MAX_WAIT_SECONDS = 50

/** the relay buffers room messages for 1 h, so a later answer can't reach this process */
const DEFAULT_REQUEST_TTL_MS = 3_600_000

/** a relay that hasn't confirmed the join by then fails the request with nothing sent, inside the hosts' 60 s tool-call timeout */
const DEFAULT_JOIN_TIMEOUT_MS = 20_000

/** a pairing as the cli saves it in ~/.clanker-wallet/pairings/<family>.json */
export interface SavedPairing {
  pubkey: string
  relay: string
  wallet: string | null
  mode: 'encrypted' | 'managed' | null
  chain_family?: string
  chain_network?: string
}

/** the families the tools request on */
type RequestFamily = 'evm' | 'bitcoin' | 'chia'
const REQUEST_FAMILIES: RequestFamily[] = ['evm', 'bitcoin', 'chia']

export interface McpServerOptions extends ChainDataOptions {
  /** the package version, reported in initialize */
  version: string
  /** review app origin (or CLANKER_WALLET_WEB_ORIGIN; default https://clanker-wallet.xyz) */
  webOrigin?: string
  identity: { agent_id: string; fingerprint: string }
  /** the saved pairing for a family, or null when that family isn't paired */
  loadPairing: (family: RequestFamily) => SavedPairing | null
  /** a new ClankerWallet with the agent identity, paired from `pairing` */
  wallet: (pairing: SavedPairing) => ClankerWallet
  /** how long a request waits for the human (default 1 h, the relay's buffer) */
  requestTtlMs?: number
  /** how long a request waits for the relay to confirm the join before failing unsent (default 20 s) */
  joinTimeoutMs?: number
}

const URGENCIES = ['low', 'medium', 'high']

const CONTEXT_PROPERTIES = {
  reason: { type: 'string', description: 'why you want this, in plain words; shown to the human on the review card' },
  urgency: { type: 'string', enum: URGENCIES, description: 'priority hint shown to the human' },
  expected_outcome: { type: 'string', description: 'what will happen once it is sent' },
}

/** the same on both request tools; the hosted connector copies these definitions verbatim */
const FROM_PROPERTY = {
  from: { type: 'string', description: 'the paired wallet address to send from, as list_pairings shows it; needed only when several wallets of the same family (evm, bitcoin or chia) are paired' },
}

/**
 * MCP tool annotations: assistants (ChatGPT, dots, Claude) may skip their confirmation prompt for read-only tools.
 * a request moves nothing until the human approves it on their device, so it is not destructive, but each call
 * sends a new request to the human's wallet.
 */
const REQUEST_HINTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
const READ_HINTS = { readOnlyHint: true, openWorldHint: false }

export const MCP_TOOLS = [
  {
    name: 'request_evm_tx',
    description: 'Ask the human to send an EVM transaction (ETH or a contract call) from their own wallet. ' +
      'Nothing is signed here: the human approves every request on their own device, or rejects it. ' +
      'Returns { request_id, review_url } once delivered; show review_url to the user, then call get_request for the outcome. ' +
      'value is an integer string in wei (1 ETH = "1000000000000000000"), no decimals.',
    inputSchema: {
      type: 'object',
      properties: {
        chain_id: { type: 'integer', description: 'EVM chain id: 1 Ethereum, 8453 Base, 84532 Base Sepolia, 10 Optimism, 42161 Arbitrum, 137 Polygon' },
        to: { type: 'string', description: 'recipient or contract: 0x followed by 40 hex characters (mixed case must be EIP-55 checksummed)' },
        value: { type: 'string', description: 'integer string in wei; "0" for a contract call that sends no ETH' },
        data: { type: 'string', description: 'hex calldata, default "0x" (a plain transfer)' },
        ...CONTEXT_PROPERTIES,
        ...FROM_PROPERTY,
      },
      required: ['chain_id', 'to', 'value', 'reason'],
    },
    annotations: REQUEST_HINTS,
  },
  {
    name: 'request_transfer',
    description: 'Ask the human to send bitcoin or chia (XCH) from their own wallet, which builds, signs and broadcasts it. ' +
      'Nothing is signed here: the human approves every request on their own device, or rejects it. ' +
      'Returns { request_id, review_url } once delivered; show review_url to the user, then call get_request for the outcome. ' +
      'amount is an integer string, no decimals: sats for bitcoin (1 BTC = "100000000"), where the wallet sets the fee; ' +
      'mojos for chia (1 XCH = "1000000000000"), with an optional fee in mojos (default "0").',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', enum: ['bitcoin', 'chia'], description: 'chain family' },
        network: {
          type: 'string',
          enum: ['mainnet', 'testnet', 'signet', 'testnet11'],
          description: 'bitcoin: mainnet, testnet or signet; chia: mainnet or testnet11. must match the paired wallet (see list_pairings)',
        },
        to: { type: 'string', description: 'address on that network: bitcoin segwit bc1... (mainnet) or tb1... (testnet, signet); chia xch1... (mainnet) or txch1... (testnet11)' },
        amount: { type: 'string', description: 'integer string in sats (bitcoin) or mojos (chia)' },
        fee: { type: 'string', description: 'chia only: integer string in mojos, default "0"; bitcoin takes none (the wallet sets it)' },
        ...CONTEXT_PROPERTIES,
        ...FROM_PROPERTY,
      },
      required: ['family', 'network', 'to', 'amount', 'reason'],
    },
    annotations: REQUEST_HINTS,
  },
  {
    name: 'request_token_transfer',
    description: 'Ask the human to send an EVM token or native coin from their own wallet. ' +
      'The human approves every request on their own device. amount is a human decimal string; never rounded. ' +
      'Use a listed symbol for that chain or pass the contract address; unlisted symbols are refused, never searched. ' +
      'Omit token (or use the native symbol) for native coin. Returns { request_id, review_url }; show review_url to the user, then call get_request.',
    inputSchema: {
      type: 'object',
      properties: {
        chain_id: { type: 'integer', description: 'EVM chain id' },
        to: { type: 'string', description: 'recipient EVM address' },
        token: { type: 'string', description: 'listed symbol on this chain or token contract address; omitted or native symbol sends native coin' },
        amount: { type: 'string', description: 'positive human decimal string, e.g. 1.25; excess fraction digits are refused' },
        ...CONTEXT_PROPERTIES,
        ...FROM_PROPERTY,
      },
      required: ['chain_id', 'to', 'amount', 'reason'],
    },
    annotations: REQUEST_HINTS,
  },
  {
    name: 'request_sign_message',
    description: 'Ask the human to sign an EVM message (personal_sign) in their own wallet. ' +
      'Returns { request_id, review_url }; show review_url to the user, then call get_request for the signature. ' +
      'Signatures can authorize spending (permits): explain why one is needed. Every signature needs human review; eth_sign is not available.',
    inputSchema: {
      type: 'object',
      properties: {
        chain_id: { type: 'integer', description: 'supported EVM chain id' },
        message: { type: 'string', description: 'UTF-8 text or 0x-prefixed even-length hex bytes; at most 32768 compact JSON UTF-8 bytes' },
        ...CONTEXT_PROPERTIES,
        ...FROM_PROPERTY,
      },
      required: ['chain_id', 'message', 'reason'],
    },
    annotations: REQUEST_HINTS,
  },
  {
    name: 'request_sign_typed_data',
    description: 'Ask the human to sign parsed EIP-712 typed data (eth_signTypedData_v4) in their own wallet. ' +
      'Returns { request_id, review_url }; show review_url to the user, then call get_request for the signature. ' +
      'Signatures can authorize spending (permits): explain why one is needed. Every signature needs human review; eth_sign is not available.',
    inputSchema: {
      type: 'object',
      properties: {
        chain_id: { type: 'integer', description: 'supported EVM chain id; must equal domain.chainId when present' },
        typed_data: {
          type: 'object',
          description: 'parsed EIP-712 object, not a JSON string; at most 32768 compact JSON UTF-8 bytes',
          properties: { domain: { type: 'object' }, types: { type: 'object' }, primaryType: { type: 'string' }, message: { type: 'object' } },
          required: ['domain', 'types', 'primaryType', 'message'],
        },
        ...CONTEXT_PROPERTIES,
        ...FROM_PROPERTY,
      },
      required: ['chain_id', 'typed_data', 'reason'],
    },
    annotations: REQUEST_HINTS,
  },
  {
    name: 'x402_fetch',
    description: 'Fetch an HTTPS resource. For x402 v2 exact EVM eip3009 payments, the human signs every payment in their wallet. max_amount is a decimal token-unit ceiling, never an auto-pay budget. Returns a free HTTP result or a pending request with review_url; get_request returns the single paid retry result. No redirects are followed.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'absolute HTTPS URL, without credentials' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'at most 20 headers and 8192 bytes; no host, content-length, hop-by-hop or payment headers' },
        body: { type: 'string', description: 'at most 16384 UTF-8 bytes; not allowed with GET' },
        max_amount: { type: 'string', description: 'required positive decimal token-unit ceiling, e.g. "0.10"; trusted token decimals, never rounded' },
        reason: CONTEXT_PROPERTIES.reason,
      },
      required: ['url', 'max_amount', 'reason'],
    },
    annotations: REQUEST_HINTS,
  },
  {
    name: 'get_request',
    description: 'Get the outcome of a request: pending, approved (with signature for signing, or tx_hash for transactions; a chia send may have none, so check the recipient\'s balance), rejected, failed (with error), unknown (with error) or expired. ' +
      `The human may take minutes to answer: pass wait_seconds (at most ${MAX_WAIT_SECONDS}) to wait for it, and call again while it is pending. ` +
      'unknown means the request was delivered but this server lost its relay connection: the human may still approve it, so ask them before sending it again. ' +
      'expired means this server stopped waiting, 1 hour after sending; after a restart it no longer knows earlier request ids. ' +
      'In both cases the human may still approve it in their wallet, so ask them before sending it again.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'from any request tool, including request_sign_message or request_sign_typed_data' },
        wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'wait up to this long for an answer (default 0)' },
      },
      required: ['request_id'],
    },
    annotations: READ_HINTS,
  },
  {
    name: 'get_balance',
    description: 'Read the balance of any address, including a recipient not paired here. EVM native or ERC-20 (listed symbol or contract address), bitcoin confirmed/mempool, or chia unspent coins at the recipient puzzle hash (not the whole wallet; excludes mempool). After a chia send approved without a hash, check the recipient balance; a balance alone does not prove which payment arrived.',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', enum: ['evm', 'bitcoin', 'chia'], description: 'chain family' },
        chain_id: { type: 'integer', description: 'required for EVM' },
        network: { type: 'string', enum: ['mainnet', 'testnet', 'signet', 'testnet11'], description: 'required for bitcoin or chia; EVM uses chain_id' },
        address: { type: 'string', description: 'any address on that network, including a recipient' },
        token: { type: 'string', description: 'EVM only: listed symbol or contract address; omitted/native symbol = native coin' },
      },
      required: ['family', 'address'],
    },
    annotations: { ...READ_HINTS, openWorldHint: true },
  },
  {
    name: 'get_tx_status',
    description: 'Read an EVM transaction receipt status and confirmations, or bitcoin confirmations. An EVM missing receipt means pending_or_unknown, not proof of submission. After a chia approval without a hash, use get_balance on the recipient instead.',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', enum: ['evm', 'bitcoin'], description: 'chain family' },
        chain_id: { type: 'integer', description: 'required for EVM' },
        network: { type: 'string', enum: ['mainnet', 'testnet', 'signet'], description: 'required for bitcoin' },
        tx_hash: { type: 'string', description: 'EVM 0x + 64 hex digits; bitcoin 64 hex digits' },
      },
      required: ['family', 'tx_hash'],
    },
    annotations: { ...READ_HINTS, openWorldHint: true },
  },
  {
    name: 'list_pairings',
    description: 'List the wallets you can request on (chain family, network, wallet address, mode) and your agent fingerprint, ' +
      'which the human compares in the web app before trusting you.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_HINTS,
  },
]

const INSTRUCTIONS = 'clanker-wallet sends transaction and signature requests to a human, who approves or rejects each one in their own wallet; ' +
  'you never hold keys. Call list_pairings to see which chains you can use, request_evm_tx, request_transfer, request_token_transfer, request_sign_message or request_sign_typed_data to ask, ' +
  'and get_request (with wait_seconds) until the request is no longer pending.'

/** what get_request reports, in the order the docs list them */
export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'failed', 'unknown', 'expired'] as const
type RequestStatus = typeof REQUEST_STATUSES[number]

const STILL_APPROVABLE = 'the request was delivered, so the human may still approve it in their wallet: ask them before sending it again'

interface RequestRecord {
  request_id: string
  status: RequestStatus
  expiresAt: number
  tx_hash?: string
  signature?: string
  error?: string
  result?: X402HttpResult
  retrying?: boolean
  /** resolves when the status leaves pending */
  settled: Promise<void>
  settle: (status: Exclude<RequestStatus, 'pending'>, detail?: { tx_hash?: string; signature?: string; error?: string; result?: X402HttpResult }) => void
}

/** a JSON-RPC error answered to the client */
class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

/** a tool's input was refused; reported as a tool result with isError, nothing sent */
class ToolInputError extends Error {}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true }

type WalletLimits = { timeout_ms: number; join_timeout_ms: number; signal: AbortSignal }

const toolResult = (body: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body) }] })
const toolError = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true })

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** reason (required, non-blank), urgency and expected_outcome from tool arguments */
function contextFrom(args: Record<string, unknown>): TxContext {
  const { reason, urgency, expected_outcome } = args
  if (typeof reason !== 'string' || !reason.trim()) throw new ToolInputError('invalid reason: say why, in plain words; the human sees it')
  const context: TxContext = { reason }
  if (urgency !== undefined) {
    if (typeof urgency !== 'string' || !URGENCIES.includes(urgency)) throw new ToolInputError(`invalid urgency: must be ${URGENCIES.join(', ')}`)
    context.urgency = urgency
  }
  if (expected_outcome !== undefined) {
    if (typeof expected_outcome !== 'string') throw new ToolInputError('invalid expected_outcome: must be a string')
    context.expected_outcome = expected_outcome
  }
  return context
}

/** the optional wallet address to send from; undefined means the saved pairing */
function fromArg(args: Record<string, unknown>): string | undefined {
  const { from } = args
  if (from !== undefined && typeof from !== 'string') throw new ToolInputError('invalid from: must be the wallet address as list_pairings shows it')
  return from
}

/** a tool error when `from` names a wallet other than the saved pairing's (case-insensitive: evm hex and bech32 both are) */
function fromMismatch(family: RequestFamily, from: string | undefined, pairing: SavedPairing): ToolResult | null {
  if (from === undefined || from.toLowerCase() === pairing.wallet?.toLowerCase()) return null
  // == null: a cli-written pairing stores null, a hand-written file may leave the key out
  const paired = pairing.wallet == null
    ? `the ${family} pairing records no wallet address to check it against`
    : `the paired ${family} wallet is ${pairing.wallet}, the only one this server sends from`
  return toolError(`from ${JSON.stringify(from)} is not the paired wallet: ${paired}; nothing was sent`)
}

const NOT_PAIRED: Record<RequestFamily, string> = {
  evm: 'not paired with an evm wallet: ask the human to open https://clanker-wallet.xyz, copy the pairing JSON, and run: clanker-wallet pair \'<JSON>\'',
  bitcoin: 'not paired with a bitcoin wallet: ask the human to open the bitcoin tab at https://clanker-wallet.xyz, copy its pairing JSON, and run: clanker-wallet pair \'<JSON>\'',
  chia: 'not paired with a chia wallet: ask the human to open the XCH tab at https://clanker-wallet.xyz, copy its pairing JSON, and run: clanker-wallet pair \'<JSON>\'',
}

export function createMcpServer(options: McpServerOptions): { handleLine: (line: string) => Promise<string | null> } {
  const webOrigin = new URL(options.webOrigin ?? process.env.CLANKER_WALLET_WEB_ORIGIN ?? 'https://clanker-wallet.xyz').origin
  const reviewUrl = (id: string) => `${webOrigin}/?request=${encodeURIComponent(id)}`
  const ttl = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS
  const joinTimeout = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS
  const chainOptions = { ...options, rpcUrls: options.rpcUrls ?? rpcUrlsFromJson(process.env.CLANKER_WALLET_RPC_URLS) }
  const records = new Map<string, RequestRecord>()
  /** tools/call requests still being answered, by JSON-RPC id, for notifications/cancelled */
  const inFlight = new Map<unknown, AbortController>()

  /**
   * start a request on the family's pairing and answer once the relay has it: { request_id } after
   * the wallet sends it, or a tool error when it fails first (bad input, `from` not the paired wallet, unreachable relay,
   * join timeout, cancelled)
   */
  function submit(family: RequestFamily, from: string | undefined, cancelled: AbortSignal, send: (wallet: ClankerWallet, limits: WalletLimits) => Promise<string | undefined>, signatureRequest = false, requestTtl = ttl, onApproved?: (signature: string) => Promise<X402HttpResult>): Promise<ToolResult> {
    if (cancelled.aborted) return Promise.resolve(toolError('request cancelled before sending; nothing was sent'))
    const pairing = options.loadPairing(family)
    if (!pairing) return Promise.resolve(toolError(NOT_PAIRED[family]))
    const mismatch = fromMismatch(family, from, pairing)
    if (mismatch) return Promise.resolve(mismatch)
    const wallet = options.wallet(pairing)
    const expiresAt = Date.now() + requestTtl
    // a cancel stops the wallet only before it sends: once delivered, the human can still approve, so keep waiting
    const unsent = new AbortController()

    return new Promise((resolve) => {
      let record: RequestRecord | undefined
      let answered: { status: string } | undefined
      // this timer decides expiry, not a Date.now() check: timers can fire a millisecond before the clock reaches their
      // target. it is set before the wallet's own timer of the same ttl, and node runs equal delays in the order they
      // were set, so the request is expired before the wallet's timeout rejection arrives
      const expiry = setTimeout(() => record?.settle('expired'), requestTtl)
      cancelled.addEventListener('abort', () => { if (!record) unsent.abort() })
      wallet.on('request_sent', ({ request_id }) => {
        record = newRecord(request_id, expiresAt)
        records.set(request_id, record)
        record.settled.then(() => clearTimeout(expiry))
        resolve(toolResult({ request_id, review_url: reviewUrl(request_id), status: 'pending', expires_at: new Date(expiresAt).toISOString() }))
      })
      wallet.on('response', (response) => { answered = response })

      send(wallet, { timeout_ms: requestTtl, join_timeout_ms: joinTimeout, signal: unsent.signal }).then(
        async (result) => {
          if (record!.status !== 'pending') return
          clearTimeout(expiry)
          if (onApproved) {
            record!.retrying = true
            try { record!.settle('approved', { result: await onApproved(result!) }) }
            catch (err) { record!.settle('failed', { error: err instanceof X402Error ? err.message : 'paid retry outcome unknown; not retried' }) }
          } else record!.settle('approved', signatureRequest ? { signature: result } : { tx_hash: result })
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          if (!record) {
            clearTimeout(expiry)
            return resolve(toolError(message))
          }
          if (answered?.status === 'rejected') record.settle('rejected')
          else if (answered) record.settle('failed', { error: message })
          // the relay refused the request (rate limit, size) and dropped it: nothing reached the human
          else if (err instanceof RelayError) record.settle('failed', { error: message })
          // delivered, then the relay connection dropped: the relay still holds the request for the human
          // (after expiry the record is already settled and this changes nothing)
          else record.settle('unknown', { error: `${message}; ${STILL_APPROVABLE}` })
        },
      )
    })
  }

  async function requestEvmTx(args: Record<string, unknown>, cancelled: AbortSignal): Promise<ToolResult> {
    const context = contextFrom(args)
    const from = fromArg(args)
    const { chain_id, transaction } = validateTx(args.chain_id, { to: args.to, value: args.value, data: args.data ?? '0x' })
    return submit('evm', from, cancelled, (wallet, limits) => wallet.requestTx({ chain_id, transaction, context, ...limits }))
  }

  async function requestTokenTransfer(args: Record<string, unknown>, cancelled: AbortSignal): Promise<ToolResult> {
    const context = contextFrom(args)
    const from = fromArg(args)
    const { chain_id, transaction } = await buildTokenTransfer({ chain_id: args.chain_id, to: args.to, token: args.token, amount: args.amount }, chainOptions)
    return submit('evm', from, cancelled, (wallet, limits) => wallet.requestTx({ chain_id, transaction, context, ...limits }))
  }

  async function requestTransfer(args: Record<string, unknown>, cancelled: AbortSignal): Promise<ToolResult> {
    const family = args.family
    if (family !== 'bitcoin' && family !== 'chia') throw new ToolInputError(`invalid family: must be "bitcoin" or "chia", got ${JSON.stringify(family)}`)
    const context = contextFrom(args)
    const from = fromArg(args)
    let request: ReturnType<typeof validateTransfer>
    try {
      const asset = family === 'bitcoin' ? 'btc' : 'xch'
      request = validateTransfer(family, args.network, { asset, to: args.to, amount: args.amount, ...(args.fee !== undefined && { fee: args.fee }) })
    } catch (err) {
      // the tool calls the network field `network`
      if (err instanceof InvalidTxError && err.field === 'chain_network') throw new ToolInputError(`invalid network: ${err.reason}`)
      throw err
    }
    const { chain_network, transfer } = request
    return submit(family, from, cancelled, async (wallet, limits) => {
      try {
        return await wallet.requestTransfer({ chain_network, transfer, context, ...limits })
      } catch (err) {
        // the pairing is for another network
        if (err instanceof InvalidTxError && err.field === 'chain_network') throw new Error(`invalid network: ${err.reason}`)
        throw err
      }
    })
  }

  async function getRequest(args: Record<string, unknown>, cancelled: AbortSignal): Promise<ToolResult> {
    const { request_id, wait_seconds = 0 } = args
    if (typeof request_id !== 'string') throw new ToolInputError('invalid request_id: must be the string request_evm_tx or request_transfer returned')
    if (typeof wait_seconds !== 'number' || !(wait_seconds >= 0)) {
      throw new ToolInputError(`invalid wait_seconds: must be a number from 0 to ${MAX_WAIT_SECONDS}`)
    }
    const record = records.get(request_id)
    if (!record) {
      throw new ToolInputError(`unknown request_id ${JSON.stringify(request_id)}: this server did not send it, or sent it before it restarted and stopped waiting. ` +
        'if it was sent before a restart, the human may still approve it in their wallet: ask them before sending it again')
    }

    const waitMs = Math.min(wait_seconds, MAX_WAIT_SECONDS) * 1000
    if (record.status === 'pending' && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waits = [record.settled, new Promise((r) => cancelled.addEventListener('abort', r, { once: true }))]
      // Approval can cancel request expiry and start a paid retry during this poll. Its wait cap stays independent.
      waits.push(new Promise((r) => { timer = setTimeout(r, waitMs) }))
      await Promise.race(waits)
      clearTimeout(timer)
    }
    // a fallback for an expiry timer that runs late (a busy process): it only marks expired once the clock has passed expires_at
    if (record.status === 'pending' && !record.retrying && Date.now() >= record.expiresAt) record.settle('expired')

    const { status, tx_hash, signature, error, result } = record
    if (status === 'pending') return toolResult({ request_id, review_url: reviewUrl(request_id), status, expires_at: new Date(record.expiresAt).toISOString() })
    return toolResult({ request_id, status, ...(tx_hash !== undefined && { tx_hash }), ...(signature !== undefined && { signature }), ...(error !== undefined && { error }), ...(result !== undefined && { result }) })
  }

  function listPairings(): ToolResult {
    const pairings = REQUEST_FAMILIES.flatMap((family) => {
      const pairing = options.loadPairing(family)
      return pairing ? [{ family, network: pairing.chain_network ?? null, wallet: pairing.wallet ?? null, mode: pairing.mode ?? null }] : []
    })
    return toolResult({ ...options.identity, pairings })
  }

  const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>, cancelled: AbortSignal) => ToolResult | Promise<ToolResult>> = {
    x402_fetch: async (args, cancelled) => {
      const context = contextFrom(args)
      const input = validateX402Fetch(args)
      if (typeof args.max_amount !== 'string' || args.max_amount.length > 400 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(args.max_amount) || !/[1-9]/.test(args.max_amount)) throw new X402Error('max_amount must be a positive decimal token-unit string')
      const response = await fetchX402(input, chainOptions)
      if (response.status !== 402) return toolResult(x402HttpResult(response, false))
      const pairing = options.loadPairing('evm')
      if (!pairing) return toolError(NOT_PAIRED.evm)
      const payment = await prepareX402(response, input.url, args.max_amount, pairing.wallet ?? '', chainOptions)
      context.x402 = payment.context
      return submit('evm', undefined, cancelled, (wallet, limits) => wallet.requestSignTypedData({ chain_id: payment.chain_id, typed_data: payment.typed_data, context, ...limits }), true, Math.min(ttl, X402_APPROVAL_MS, payment.expires_at - Date.now()), signature => retryX402(input, payment, signature, chainOptions))
    },
    request_sign_message: (args, cancelled) => {
      const context = contextFrom(args)
      const from = fromArg(args)
      const { chain_id, sign } = validateSign(args.chain_id, { method: 'personal_sign', message: args.message })
      if (sign.method !== 'personal_sign') throw new ToolInputError('invalid method')
      return submit('evm', from, cancelled, (wallet, limits) => wallet.requestSignMessage({ chain_id, message: sign.message, context, ...limits }), true)
    },
    request_sign_typed_data: (args, cancelled) => {
      const context = contextFrom(args)
      const from = fromArg(args)
      const { chain_id, sign } = validateSign(args.chain_id, { method: 'eth_signTypedData_v4', typed_data: args.typed_data })
      if (sign.method !== 'eth_signTypedData_v4') throw new ToolInputError('invalid method')
      return submit('evm', from, cancelled, (wallet, limits) => wallet.requestSignTypedData({ chain_id, typed_data: sign.typed_data, context, ...limits }), true)
    },
    request_evm_tx: requestEvmTx,
    request_transfer: requestTransfer,
    request_token_transfer: requestTokenTransfer,
    get_request: getRequest,
    get_balance: async (args) => toolResult(await getBalance(args, chainOptions)),
    get_tx_status: async (args) => toolResult(await getTxStatus(args, chainOptions)),
    list_pairings: listPairings,
  }

  async function callTool(params: unknown, cancelled: AbortSignal): Promise<ToolResult> {
    if (!isObject(params) || typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name')
    const handler = TOOL_HANDLERS[params.name]
    if (!handler) throw new RpcError(INVALID_PARAMS, `unknown tool: ${params.name}`)
    const args = params.arguments ?? {}
    if (!isObject(args)) throw new RpcError(INVALID_PARAMS, 'tool arguments must be an object')
    try {
      return await handler(args, cancelled)
    } catch (err) {
      if (err instanceof X402Error) return err.offered ? { ...toolResult({ error: err.message, offered: err.offered }), isError: true } : toolError(err.message)
      if (err instanceof ToolInputError || err instanceof InvalidTxError || err instanceof ChainDataError) return toolError(err.message)
      throw err
    }
  }

  function initialize(params: unknown) {
    const requested = isObject(params) ? params.protocolVersion : undefined
    const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0]
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'clanker-wallet', version: options.version },
      instructions: INSTRUCTIONS,
    }
  }

  async function dispatch(method: string, params: unknown, cancelled: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'initialize': return initialize(params)
      case 'ping': return {}
      case 'tools/list': return { tools: MCP_TOOLS }
      case 'tools/call': return callTool(params, cancelled)
      default: throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  /** the reply to one input line, or null when none is due (blank line, notification, a response from the client) */
  async function handleLine(line: string): Promise<string | null> {
    if (!line.trim()) return null
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return reply(null, { error: { code: PARSE_ERROR, message: 'parse error: each line must be one JSON-RPC message' } })
    }
    if (Array.isArray(msg)) return reply(null, { error: { code: INVALID_REQUEST, message: 'batches are not supported' } })
    if (!isObject(msg)) return reply(null, { error: { code: INVALID_REQUEST, message: 'invalid request' } })

    const hasId = 'id' in msg
    const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null
    if (hasId && id === null) return reply(null, { error: { code: INVALID_REQUEST, message: 'invalid request: id must be a string or number' } })
    if (typeof msg.method !== 'string') {
      // a response to us: we send no requests, so there is nothing to match it with
      if ('result' in msg || 'error' in msg) return null
      return reply(id, { error: { code: INVALID_REQUEST, message: 'invalid request: no method' } })
    }
    if (msg.jsonrpc !== '2.0') return reply(id, { error: { code: INVALID_REQUEST, message: 'invalid request: jsonrpc must be "2.0"' } })
    // notifications need no answer; only cancelled changes anything here
    if (!hasId) {
      if (msg.method === 'notifications/cancelled' && isObject(msg.params)) inFlight.get(msg.params.requestId)?.abort()
      return null
    }

    const controller = new AbortController()
    inFlight.set(id, controller)
    let answer: string
    try {
      answer = reply(id, { result: await dispatch(msg.method, msg.params, controller.signal) })
    } catch (err) {
      if (err instanceof RpcError) answer = reply(id, { error: { code: err.code, message: err.message } })
      else answer = reply(id, { error: { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) } })
    } finally {
      if (inFlight.get(id) === controller) inFlight.delete(id)
    }
    // the client gave up on this call: it expects no response
    return controller.signal.aborted ? null : answer
  }

  return { handleLine }
}

function reply(id: string | number | null, body: { result: unknown } | { error: { code: number; message: string } }): string {
  return JSON.stringify({ jsonrpc: '2.0', id, ...body })
}

function newRecord(request_id: string, expiresAt: number): RequestRecord {
  let resolveSettled!: () => void
  const record: RequestRecord = {
    request_id,
    status: 'pending',
    expiresAt,
    settled: new Promise((r) => { resolveSettled = r }),
    settle: (status, detail = {}) => {
      if (record.status !== 'pending') return
      record.status = status
      record.tx_hash = detail.tx_hash
      record.signature = detail.signature
      record.error = detail.error
      record.result = detail.result
      resolveSettled()
    },
  }
  return record
}
