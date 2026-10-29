import type { ClankerWallet } from './client.js'
import type { TxContext } from './types.js'
import { InvalidTxError, validateTransfer, validateTx } from './validate.js'

/**
 * MCP server for `clanker-wallet mcp`: newline-delimited JSON-RPC 2.0 over stdio, hand-written so
 * tweetnacl stays the only runtime dependency. the cli owns stdin/stdout and the identity and pairing
 * files; this module answers one line at a time and keeps each request's state in memory.
 */

/** newest first; a client asking for another version gets the newest */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

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

/** the families the tools request on; chia waits until the web app shows it again */
type RequestFamily = 'evm' | 'bitcoin'
const REQUEST_FAMILIES: RequestFamily[] = ['evm', 'bitcoin']

export interface McpServerOptions {
  /** the package version, reported in initialize */
  version: string
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

export const MCP_TOOLS = [
  {
    name: 'request_evm_tx',
    description: 'Ask the human to send an EVM transaction (ETH or a contract call) from their own wallet. ' +
      'Nothing is signed here: the human approves every request on their own device, or rejects it. ' +
      'Returns { request_id } once the request is delivered; then call get_request for the outcome. ' +
      'value is an integer string in wei (1 ETH = "1000000000000000000"), no decimals.',
    inputSchema: {
      type: 'object',
      properties: {
        chain_id: { type: 'integer', description: 'EVM chain id: 1 Ethereum, 8453 Base, 84532 Base Sepolia, 10 Optimism, 42161 Arbitrum, 137 Polygon' },
        to: { type: 'string', description: 'recipient or contract: 0x followed by 40 hex characters (mixed case must be EIP-55 checksummed)' },
        value: { type: 'string', description: 'integer string in wei; "0" for a contract call that sends no ETH' },
        data: { type: 'string', description: 'hex calldata, default "0x" (a plain transfer)' },
        ...CONTEXT_PROPERTIES,
      },
      required: ['chain_id', 'to', 'value', 'reason'],
    },
  },
  {
    name: 'request_transfer',
    description: 'Ask the human to send bitcoin from their own wallet, which builds, signs and broadcasts it. ' +
      'Nothing is signed here: the human approves every request on their own device, or rejects it. ' +
      'Returns { request_id } once the request is delivered; then call get_request for the outcome. ' +
      'amount is an integer string in sats (1 BTC = "100000000"), no decimals; the wallet sets the fee.',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', enum: ['bitcoin'], description: 'chain family' },
        network: { type: 'string', enum: ['mainnet', 'testnet', 'signet'], description: 'must match the paired wallet (see list_pairings)' },
        to: { type: 'string', description: 'segwit address on that network: bc1... on mainnet, tb1... on testnet and signet' },
        amount: { type: 'string', description: 'integer string in sats' },
        ...CONTEXT_PROPERTIES,
      },
      required: ['family', 'network', 'to', 'amount', 'reason'],
    },
  },
  {
    name: 'get_request',
    description: 'Get the outcome of a request: pending, approved (with tx_hash), rejected, failed (with error), unknown (with error) or expired. ' +
      `The human may take minutes to answer: pass wait_seconds (at most ${MAX_WAIT_SECONDS}) to wait for it, and call again while it is pending. ` +
      'unknown means the request was delivered but this server lost its relay connection: the human may still approve it, so ask them before sending it again. ' +
      'A request expires 1 hour after it is sent, or when this server restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'from request_evm_tx or request_transfer' },
        wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'wait up to this long for an answer (default 0)' },
      },
      required: ['request_id'],
    },
  },
  {
    name: 'list_pairings',
    description: 'List the wallets you can request on (chain family, network, wallet address, mode) and your agent fingerprint, ' +
      'which the human compares in the web app before trusting you.',
    inputSchema: { type: 'object', properties: {} },
  },
]

const INSTRUCTIONS = 'clanker-wallet sends transaction requests to a human, who approves or rejects each one in their own wallet; ' +
  'you never hold keys. Call list_pairings to see which chains you can use, request_evm_tx or request_transfer to ask, ' +
  'and get_request (with wait_seconds) until the request is no longer pending.'

type RequestStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'unknown' | 'expired'

const STILL_APPROVABLE = 'the request was delivered, so the human may still approve it in their wallet: ask them before sending it again'

interface RequestRecord {
  request_id: string
  status: RequestStatus
  expiresAt: number
  tx_hash?: string
  error?: string
  /** resolves when the status leaves pending */
  settled: Promise<void>
  settle: (status: Exclude<RequestStatus, 'pending'>, detail?: { tx_hash?: string; error?: string }) => void
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

const NOT_PAIRED: Record<RequestFamily, string> = {
  evm: 'not paired with an evm wallet: ask the human to open https://clanker-wallet.xyz, copy the pairing JSON, and run: clanker-wallet pair \'<JSON>\'',
  bitcoin: 'not paired with a bitcoin wallet: ask the human to open the bitcoin tab at https://clanker-wallet.xyz, copy its pairing JSON, and run: clanker-wallet pair \'<JSON>\'',
}

export function createMcpServer(options: McpServerOptions): { handleLine: (line: string) => Promise<string | null> } {
  const ttl = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS
  const joinTimeout = options.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS
  const records = new Map<string, RequestRecord>()
  /** tools/call requests still being answered, by JSON-RPC id, for notifications/cancelled */
  const inFlight = new Map<unknown, AbortController>()

  /**
   * start a request on the family's pairing and answer once the relay has it: { request_id } after
   * the wallet sends it, or a tool error when it fails first (bad input, unreachable relay, join timeout, cancelled)
   */
  function submit(family: RequestFamily, cancelled: AbortSignal, send: (wallet: ClankerWallet, limits: WalletLimits) => Promise<string>): Promise<ToolResult> {
    const pairing = options.loadPairing(family)
    if (!pairing) return Promise.resolve(toolError(NOT_PAIRED[family]))
    const wallet = options.wallet(pairing)
    // stamped before the wallet starts its own timer, so its timeout never lands before expiresAt
    const expiresAt = Date.now() + ttl
    // a cancel stops the wallet only before it sends: once delivered, the human can still approve, so keep waiting
    const unsent = new AbortController()

    return new Promise((resolve) => {
      let record: RequestRecord | undefined
      let answered: { status: string } | undefined
      cancelled.addEventListener('abort', () => { if (!record) unsent.abort() })
      wallet.on('request_sent', ({ request_id }) => {
        record = newRecord(request_id, expiresAt)
        records.set(request_id, record)
        resolve(toolResult({ request_id, status: 'pending', expires_at: new Date(expiresAt).toISOString() }))
      })
      wallet.on('response', (response) => { answered = response })

      send(wallet, { timeout_ms: ttl, join_timeout_ms: joinTimeout, signal: unsent.signal }).then(
        (txHash) => record!.settle('approved', { tx_hash: txHash }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          if (!record) return resolve(toolError(message))
          if (answered?.status === 'rejected') record.settle('rejected')
          else if (answered) record.settle('failed', { error: message })
          // delivered, then the relay connection dropped: the relay still holds the request for the human
          else if (Date.now() < expiresAt) record.settle('unknown', { error: `${message}; ${STILL_APPROVABLE}` })
          else record.settle('expired')
        },
      )
    })
  }

  async function requestEvmTx(args: Record<string, unknown>, cancelled: AbortSignal): Promise<ToolResult> {
    const context = contextFrom(args)
    const { chain_id, transaction } = validateTx(args.chain_id, { to: args.to, value: args.value, data: args.data ?? '0x' })
    return submit('evm', cancelled, (wallet, limits) => wallet.requestTx({ chain_id, transaction, context, ...limits }))
  }

  async function requestTransfer(args: Record<string, unknown>, cancelled: AbortSignal): Promise<ToolResult> {
    if (args.family !== 'bitcoin') throw new ToolInputError(`invalid family: must be "bitcoin", got ${JSON.stringify(args.family)}`)
    const context = contextFrom(args)
    let request: ReturnType<typeof validateTransfer>
    try {
      request = validateTransfer('bitcoin', args.network, { asset: 'btc', to: args.to, amount: args.amount })
    } catch (err) {
      // the tool calls the network field `network`
      if (err instanceof InvalidTxError && err.field === 'chain_network') throw new ToolInputError(`invalid network: ${err.reason}`)
      throw err
    }
    const { chain_network, transfer } = request
    return submit('bitcoin', cancelled, async (wallet, limits) => {
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
      throw new ToolInputError(`unknown request_id ${JSON.stringify(request_id)}: this server did not send it. ` +
        'a request from before the server restarted can no longer be tracked; treat it as expired and ask the human whether it went through')
    }

    const waitMs = Math.min(wait_seconds, MAX_WAIT_SECONDS) * 1000
    if (record.status === 'pending' && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        record.settled,
        new Promise((r) => { timer = setTimeout(r, Math.min(waitMs, record.expiresAt - Date.now())) }),
        new Promise((r) => cancelled.addEventListener('abort', r, { once: true })),
      ])
      clearTimeout(timer)
    }
    if (record.status === 'pending' && Date.now() >= record.expiresAt) record.settle('expired')

    const { status, tx_hash, error } = record
    if (status === 'pending') return toolResult({ request_id, status, expires_at: new Date(record.expiresAt).toISOString() })
    return toolResult({ request_id, status, ...(tx_hash !== undefined && { tx_hash }), ...(error !== undefined && { error }) })
  }

  function listPairings(): ToolResult {
    const pairings = REQUEST_FAMILIES.flatMap((family) => {
      const pairing = options.loadPairing(family)
      return pairing ? [{ family, network: pairing.chain_network ?? null, wallet: pairing.wallet ?? null, mode: pairing.mode ?? null }] : []
    })
    return toolResult({ ...options.identity, pairings })
  }

  const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>, cancelled: AbortSignal) => ToolResult | Promise<ToolResult>> = {
    request_evm_tx: requestEvmTx,
    request_transfer: requestTransfer,
    get_request: getRequest,
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
      if (err instanceof ToolInputError || err instanceof InvalidTxError) return toolError(err.message)
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
      record.error = detail.error
      resolveSettled()
    },
  }
  return record
}
