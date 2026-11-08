import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { ClankerWallet } from './client.js'
import { toHex } from './crypto.js'
import { createMcpServer, MAX_WAIT_SECONDS, MCP_TOOLS, REQUEST_STATUSES, type SavedPairing } from './mcp.js'
import { joinAsHuman, startTestRelay, type TestHuman, type TestRelay } from './testRelay.js'

const TO = '0x2222222222222222222222222222222222222222'
const BTC_TEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const TXCH = 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg'
const XCH = 'xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0srg6dkm'
const TX_HASH = '0x' + 'ab'.repeat(32)

let relay: TestRelay
const humans: TestHuman[] = []

beforeAll(async () => { relay = await startTestRelay() })
afterAll(async () => {
  for (const h of humans) h.close()
  await relay.close()
})

async function human(respond?: Parameters<typeof joinAsHuman>[1]) {
  const h = await joinAsHuman(relay.url, respond)
  humans.push(h)
  return h
}

const approve = (req: any) => ({ request_id: req.request_id, status: 'approved', tx_hash: TX_HASH })
/** Sage's chia_send reports no transaction id */
const approveWithoutHash = (req: any) => ({ request_id: req.request_id, status: 'approved' })

interface ServerOptions {
  webOrigin?: string
  requestTtlMs?: number
  joinTimeoutMs?: number
  /** sees each per-request wallet before the server uses it */
  onWallet?: (wallet: ClankerWallet) => void
}

/** an mcp server for one agent identity, paired per family as given (the cli wires its own pairing files the same way) */
function server(pairings: Partial<Record<string, SavedPairing>>, { requestTtlMs, joinTimeoutMs, onWallet, webOrigin }: ServerOptions = {}) {
  const secretKey = new Uint8Array(randomBytes(32))
  const identity = new ClankerWallet({ secretKey })
  const mcp = createMcpServer({
    webOrigin,
    version: '9.9.9',
    identity: { agent_id: identity.agentId, fingerprint: toHex(identity.publicKey).slice(0, 16) },
    loadPairing: (family) => pairings[family] ?? null,
    wallet: (pairing) => {
      const wallet = new ClankerWallet({ secretKey })
      wallet.pair(JSON.stringify({ version: 1, ...pairing }))
      onWallet?.(wallet)
      return wallet
    },
    requestTtlMs,
    joinTimeoutMs,
  })
  let nextId = 1
  const rpc = async (method: string, params?: unknown) => {
    const reply = await mcp.handleLine(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }))
    return JSON.parse(reply!)
  }
  /** a tools/call result: `isError` and the parsed text payload (or the error text) */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { result, error } = await rpc('tools/call', { name, arguments: args })
    if (error) return { isError: true, text: error.message }
    const text = result.content[0].text
    return result.isError ? { isError: true, text } : { isError: false, body: JSON.parse(text) }
  }
  return { mcp, rpc, call }
}

const evmPairing = (room: string, extra: Partial<SavedPairing> = {}): SavedPairing =>
  ({ pubkey: room, relay: relay.url, wallet: '0x1111111111111111111111111111111111111111', mode: null, ...extra })
const btcPairing = (room: string, extra: Partial<SavedPairing> = {}): SavedPairing =>
  ({ pubkey: room, relay: relay.url, wallet: 'tb1me', mode: null, chain_family: 'bitcoin', ...extra })
const chiaPairing = (room: string, extra: Partial<SavedPairing> = {}): SavedPairing =>
  ({ pubkey: room, relay: relay.url, wallet: 'txch1me', mode: null, chain_family: 'chia', ...extra })

const evmArgs = { chain_id: 84532, to: TO, value: '1000', reason: 'pay the test address', urgency: 'low' }
const btcArgs = { family: 'bitcoin', network: 'testnet', to: BTC_TEST, amount: '1000', reason: 'pay', expected_outcome: 'paid' }
const chiaArgs = { family: 'chia', network: 'testnet11', to: TXCH, amount: '1000', reason: 'pay' }
const sentTo = (room: string) => relay.received.filter((m) => m.type === 'message' && m.room === room)

describe('x402 tools', () => {
  it('refuses malformed structured x402 context before sending a direct sign request', async () => {
    const h = await human()
    const wallet = new ClankerWallet()
    wallet.pair(JSON.stringify({ version: 1, ...evmPairing(h.room) }))
    await expect(wallet.requestSignMessage({ chain_id: 1, message: 'hello', context: { x402: {} as any }, timeout_ms: 100 })).rejects.toThrow(/x402 context/)
    expect(h.requests).toEqual([])
  })
  it('returns a free HTTP result without pairing or signing, and refuses unsafe input', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('free', { headers: { 'content-type': 'text/plain' } }))
    try {
      const { call } = server({})
      expect(await call('x402_fetch', { url: 'https://service.example/free', max_amount: '0.1', reason: 'read data' })).toEqual({ isError: false, body: { status: 200, content_type: 'text/plain', body: 'free', bytes: 4, paid: false } })
      expect((await call('x402_fetch', { url: 'http://localhost/', max_amount: '0.1', reason: 'read' })).isError).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { fetch.mockRestore() }
  })
  it('waits for explicit human signature, retries only once and caches the result', async () => {
    const h = await human(req => ({ request_id: req.request_id, status: 'approved', signature: '0x' + 'ab'.repeat(65) }))
    const { call } = server({ evm: evmPairing(h.room) })
    const requirement = { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payTo: TO, maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (new Headers(init?.headers).has('payment-signature')) return new Response('paid', { headers: { 'content-type': 'text/plain' } })
      return new Response('{}', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: 'https://service.example/paid' }, accepts: [requirement] })).toString('base64') } })
    })
    try {
      const sent = await call('x402_fetch', { url: 'https://service.example/paid', max_amount: '0.01', reason: 'read data' })
      expect(sent.isError).toBe(false)
      expect(sent.body.status).toBe('pending')
      const result = await call('get_request', { request_id: sent.body.request_id, wait_seconds: 1 })
      expect(result.body).toMatchObject({ status: 'approved', result: { paid: true, body: 'paid' } })
      expect(await call('get_request', { request_id: sent.body.request_id })).toEqual(result)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(h.requests[0]).toMatchObject({ sign: { method: 'eth_signTypedData_v4' }, context: { x402: { amount: '10000' } } })
      expect(Date.parse(sent.body.expires_at) - Date.now()).toBeLessThanOrEqual(600000)
    } finally { fetch.mockRestore() }
  })
})

describe('signature tools', () => {
  it.each(['request_sign_message', 'request_sign_typed_data'])('%s returns review URL then signature, never tx_hash', async name => {
    const signature = '0x' + 'ab'.repeat(65)
    const h = await human(req => ({ request_id: req.request_id, status: 'approved', signature }))
    const { call } = server({ evm: evmPairing(h.room) })
    const payload = name === 'request_sign_message' ? { message: '0x00ff' } : { typed_data: { domain: { chainId: 1 }, types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Mail: [] }, primaryType: 'Mail', message: {} } }
    const sent = await call(name, { chain_id: 1, reason: 'login', ...payload })
    expect(sent.isError).toBe(false)
    expect(sent.body.review_url).toContain('?request=')
    expect(await call('get_request', { request_id: sent.body.request_id, wait_seconds: 1 })).toEqual({ isError: false, body: { request_id: sent.body.request_id, status: 'approved', signature } })
    expect(h.requests[0]).toHaveProperty('sign')
  })
  it('refuses malformed and over-budget payloads without delivery', async () => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) })
    for (const args of [{ chain_id: 2, message: 'hello' }, { chain_id: 1, message: '0x0' }, { chain_id: 1, message: 'a'.repeat(32768) }]) {
      expect((await call('request_sign_message', { reason: 'test', ...args })).isError).toBe(true)
    }
    expect(h.requests).toEqual([])
  })
})

describe('mcp protocol', () => {
  const { mcp, rpc } = server({})

  it('initialize echoes a supported protocol version and offers our latest otherwise', async () => {
    for (const version of ['2024-11-05', '2025-06-18', '2025-11-25']) {
      const { result } = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } })
      expect(result.protocolVersion).toBe(version)
      expect(result.capabilities).toEqual({ tools: {} })
      expect(result.serverInfo).toEqual({ name: 'clanker-wallet', version: '9.9.9' })
    }
    const { result } = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(result.protocolVersion).toBe('2025-11-25')
  })

  it('does not offer 2025-03-26, which requires receiving batches', async () => {
    const { result } = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } })
    expect(result.protocolVersion).toBe('2025-11-25')
  })

  it('answers ping, ignores notifications, and refuses unknown methods with -32601', async () => {
    expect(await rpc('ping')).toMatchObject({ result: {} })
    expect(await mcp.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull()
    expect(await mcp.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatever' }))).toBeNull()
    expect(await rpc('resources/list')).toMatchObject({ error: { code: -32601 } })
  })

  it.each([
    ['not json', '{"jsonrpc":', -32700, null],
    ['a batch', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', -32600, null],
    ['no method', '{"jsonrpc":"2.0","id":3}', -32600, 3],
    ['wrong jsonrpc version', '{"jsonrpc":"1.0","id":4,"method":"ping"}', -32600, 4],
    ['an object id', '{"jsonrpc":"2.0","id":{},"method":"ping"}', -32600, null],
    ['a scalar', '42', -32600, null],
    ['an unknown tool', '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"sign_everything"}}', -32602, 5],
    ['non-object tool arguments', '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_pairings","arguments":[]}}', -32602, 6],
  ])('answers %s with a JSON-RPC error', async (_name, line, code, id) => {
    const reply = JSON.parse((await mcp.handleLine(line))!)
    expect(reply).toMatchObject({ jsonrpc: '2.0', id, error: { code } })
  })

  it('ignores blank lines and responses from the client', async () => {
    expect(await mcp.handleLine('   ')).toBeNull()
    expect(await mcp.handleLine('{"jsonrpc":"2.0","id":9,"result":{}}')).toBeNull()
  })

  it('lists the tools with object schemas, stating human approval and integer-string amounts', async () => {
    const { result } = await rpc('tools/list')
    expect(result.tools.map((t: any) => t.name)).toEqual(['request_evm_tx', 'request_transfer', 'request_token_transfer', 'request_sign_message', 'request_sign_typed_data', 'x402_fetch', 'get_request', 'get_balance', 'get_tx_status', 'list_pairings'])
    for (const tool of result.tools) expect(tool.inputSchema.type).toBe('object')
    const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]))
    for (const name of ['request_evm_tx', 'request_transfer']) {
      expect(byName[name].description).toMatch(/human approves every request on their (own )?device/i)
      expect(byName[name].description).toMatch(/integer string/i)
    }
    expect(byName.request_evm_tx.description).toContain('wei')
    expect(byName.request_transfer.description).toContain('sats')
    expect(byName.request_transfer.description).toContain('mojos')
    for (const status of REQUEST_STATUSES) expect(byName.get_request.description).toContain(status)
    expect(byName.get_request.inputSchema.properties.wait_seconds.maximum).toBe(MAX_WAIT_SECONDS)
    expect(MAX_WAIT_SECONDS).toBeLessThanOrEqual(50)
    expect(result.tools).toEqual(MCP_TOOLS)
  })

  it('offers an optional from (the wallet to send from) on both request tools, described the same way', async () => {
    const { result } = await rpc('tools/list')
    const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]))
    const descriptions = ['request_evm_tx', 'request_transfer'].map((name) => {
      const { properties, required } = byName[name].inputSchema
      expect(properties.from, name).toMatchObject({ type: 'string' })
      expect(required, name).not.toContain('from')
      expect(properties.from.description, name).toContain('list_pairings')
      // pairings are per family, not per chain_id: "this chain" would read as chain_id
      expect(properties.from.description, name).toMatch(/family/)
      expect(properties.from.description, name).not.toMatch(/\bchain\b/)
      return properties.from.description
    })
    expect(descriptions[0]).toBe(descriptions[1])
    for (const name of ['get_request', 'list_pairings']) expect(byName[name].inputSchema.properties.from, name).toBeUndefined()
  })

  it('marks the reading tools read-only, so an assistant can poll without asking each time', async () => {
    const { result } = await rpc('tools/list')
    const annotations = Object.fromEntries(result.tools.map((t: any) => [t.name, t.annotations]))
    const request = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    const read = { readOnlyHint: true, openWorldHint: false }
    expect(annotations).toEqual({ request_evm_tx: request, request_transfer: request, request_token_transfer: request, request_sign_message: request, request_sign_typed_data: request, x402_fetch: request, get_request: read, get_balance: { ...read, openWorldHint: true }, get_tx_status: { ...read, openWorldHint: true }, list_pairings: read })
  })
})

describe('chain read tools', () => {
  it('reads an arbitrary EVM native balance without pairing and preserves exact units', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ result: '0x6f05b59d3b20000' })))
    try {
      const result = await server({}).call('get_balance', { family: 'evm', chain_id: 1, address: TO })
      expect(result.isError).toBe(false)
      expect(result.body).toMatchObject({ raw_balance: '500000000000000000', balance: '0.5', decimals: 18, asset: 'ETH' })
    } finally { fetcher.mockRestore() }
  })

  it('reads listed ERC-20 balanceOf on the requested chain', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ result: '0x' + (1250000n).toString(16).padStart(64, '0') })))
    try {
      const result = await server({}).call('get_balance', { family: 'evm', chain_id: 84532, address: TO, token: 'USDC' })
      expect(result.isError).toBe(false)
      expect(result.body).toMatchObject({ raw_balance: '1250000', balance: '1.25', asset: 'USDC', decimals: 6 })
      const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
      expect(body.params[0].data).toBe('0x70a08231' + TO.slice(2).toLowerCase().padStart(64, '0'))
    } finally { fetcher.mockRestore() }
  })

  it.each(['mainnet', 'testnet', 'signet'])('reads bitcoin confirmed and mempool deltas on %s', async network => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      chain_stats: { funded_txo_sum: 200000000, spent_txo_sum: 50000000 }, mempool_stats: { funded_txo_sum: 10000000, spent_txo_sum: 20000000 },
    })))
    try {
      const result = await server({}).call('get_balance', { family: 'bitcoin', network, address: network === 'mainnet' ? 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' : BTC_TEST })
      expect(result.isError).toBe(false)
      expect(result.body).toMatchObject({ raw_balance: '140000000', balance: '1.4', confirmed_balance: '1.5', unconfirmed_balance: '-0.1' })
      expect(String(fetcher.mock.calls[0][0])).toContain(network === 'mainnet' ? 'mempool.space/api/' : 'mempool.space/' + network + '/api/')
    } finally { fetcher.mockRestore() }
  })

  it.each(['mainnet', 'testnet11'])('decodes a chia recipient and sums unspent uint64 coin records exactly on %s', async network => {
    const hash = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '{"success":true,"coin_records":[{"spent":false,"coin":{"parent_coin_info":"0x' + 'aa'.repeat(32) + '","puzzle_hash":"' + hash + '","amount":18446744073709551615}}]}',
    ))
    try {
      const result = await server({}).call('get_balance', { family: 'chia', network, address: network === 'mainnet' ? XCH : TXCH })
      expect(result.isError).toBe(false)
      expect(result.body).toMatchObject({ raw_balance: '18446744073709551615', balance: '18446744.073709551615', asset: 'XCH', decimals: 12 })
      expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ puzzle_hash: hash, include_spent_coins: false })
    } finally { fetcher.mockRestore() }
  })

  it.each(['0x0', '0x1'])('reads EVM receipt status %s and confirmations', async receiptStatus => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { method } = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({ result: method === 'eth_blockNumber' ? '0x66' : { status: receiptStatus, blockNumber: '0x64' } }))
    })
    try {
      const result = await server({}).call('get_tx_status', { family: 'evm', chain_id: 1, tx_hash: TX_HASH })
      expect(result.isError).toBe(false)
      expect(result.body).toMatchObject({ status: receiptStatus === '0x1' ? 'confirmed' : 'failed', confirmations: 3 })
    } finally { fetcher.mockRestore() }
  })

  it('does not claim an unknown EVM hash was submitted', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ result: null })))
    try {
      const result = await server({}).call('get_tx_status', { family: 'evm', chain_id: 1, tx_hash: TX_HASH })
      expect(result.body).toMatchObject({ status: 'pending_or_unknown', confirmations: 0 })
    } finally { fetcher.mockRestore() }
  })

  it('reads bitcoin confirmations from the matching network tip', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/blocks/tip/height')
      ? new Response('102') : new Response(JSON.stringify({ confirmed: true, block_height: 100 })))
    try {
      const result = await server({}).call('get_tx_status', { family: 'bitcoin', network: 'signet', tx_hash: 'ab'.repeat(32) })
      expect(result.body).toMatchObject({ status: 'confirmed', confirmations: 3 })
    } finally { fetcher.mockRestore() }
  })

  it('refuses malformed data instead of fabricating a zero balance', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'))
    try {
      for (const args of [{ family: 'evm', chain_id: 1, address: TO }, { family: 'bitcoin', network: 'testnet', address: BTC_TEST }, { family: 'chia', network: 'testnet11', address: TXCH }]) {
        expect((await server({}).call('get_balance', args)).isError).toBe(true)
      }
    } finally { fetcher.mockRestore() }
  })
})

describe('request_token_transfer', () => {
  it('cancels without sending when the user cancels during token metadata reads', async () => {
    const h = await human()
    const delivered: string[] = []
    const { mcp } = server({ evm: evmPairing(h.room) }, { requestTtlMs: 200, onWallet: wallet => {
      wallet.on('request_sent', event => delivered.push(event.request_id))
    } })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      await gate
      const data = JSON.parse(init!.body as string).params[0].data
      return new Response(JSON.stringify({ result: data === '0x313ce567' ? '0x' + '0'.repeat(63) + '6' : '0x' + '414243'.padEnd(64, '0') }))
    })
    try {
      const pending = mcp.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'cancel-token', method: 'tools/call', params: {
        name: 'request_token_transfer', arguments: { chain_id: 1, to: TO, token: TO, amount: '1', reason: 'pay' },
      } }))
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
      await mcp.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-token' } }))
      release()
      expect(await pending).toBeNull()
      expect(delivered).toHaveLength(0)
      expect(h.requests).toHaveLength(0)
    } finally { release(); fetcher.mockRestore() }
  })

  it('builds a listed USDC transfer with exact human units and the existing wire kind', async () => {
    const h = await human(approve)
    const { call } = server({ evm: evmPairing(h.room) })
    const sent = await call('request_token_transfer', { chain_id: 84532, to: TO, token: 'USDC', amount: '1.25', reason: 'pay' })
    expect(sent.isError).toBe(false)
    await call('get_request', { request_id: sent.body.request_id, wait_seconds: 5 })
    expect(h.requests[0]).toMatchObject({
      chain_id: 84532,
      transaction: { to: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', value: '0',
        data: '0xa9059cbb' + TO.slice(2).toLowerCase().padStart(64, '0') + (1250000n).toString(16).padStart(64, '0') },
      context: { reason: 'pay' },
    })
    expect(sent.body.review_url).toContain('?request=')
  })

  it.each([
    ['USDC', '0.0000001', 'fraction'],
    ['NOTACOIN', '1', 'pass the contract address'],
    ['USDC', '1e6', 'decimal'],
    ['USDC', '-1', 'decimal'],
  ])('refuses %s %s without sending', async (token, amount, error) => {
    const { call } = server({})
    const result = await call('request_token_transfer', { chain_id: 84532, to: TO, token, amount, reason: 'pay' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain(error)
  })

  it('reads unlisted contract metadata and refuses an unavailable decimals/symbol', async () => {
    const h = await human(approve)
    const { call } = server({ evm: evmPairing(h.room) })
    const symbol = '0x' + (32).toString(16).padStart(64, '0') + (3).toString(16).padStart(64, '0') + '414243'.padEnd(64, '0')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(init!.body as string)
      const result = body.params[0].data === '0x313ce567' ? '0x' + (8).toString(16).padStart(64, '0') : symbol
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    })
    try {
      const sent = await call('request_token_transfer', { chain_id: 84532, to: TO, token: TO, amount: '1.12345678', reason: 'pay' })
      expect(sent.isError).toBe(false)
      await call('get_request', { request_id: sent.body.request_id, wait_seconds: 5 })
      expect(h.requests[0].transaction.data).toContain((112345678n).toString(16).padStart(64, '0'))
      fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'reverted' } })))
      const refused = await call('request_token_transfer', { chain_id: 84532, to: TO, token: TO, amount: '1', reason: 'pay' })
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('metadata')
    } finally { fetcher.mockRestore() }
  })

  it.each([undefined, 'ETH'])('sends native units when token is %s', async (token) => {
    const h = await human(approve)
    const { call } = server({ evm: evmPairing(h.room) })
    const sent = await call('request_token_transfer', { chain_id: 84532, to: TO, token, amount: '0.5', reason: 'pay' })
    expect(sent.isError).toBe(false)
    await call('get_request', { request_id: sent.body.request_id, wait_seconds: 5 })
    expect(h.requests[0].transaction).toEqual({ to: TO, value: '500000000000000000', data: '0x' })
  })
})

describe('request_evm_tx + get_request', () => {
  it.each([undefined, 'https://review.example'])('returns a safe review_url for sends and pending polls (%s)', async (webOrigin) => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room), bitcoin: btcPairing(h.room) }, { webOrigin, requestTtlMs: 200 })
    for (const [name, args] of [['request_evm_tx', evmArgs], ['request_transfer', btcArgs]] as const) {
      const { body } = await call(name, args)
      const expected = (webOrigin ?? 'https://clanker-wallet.xyz') + '/?request=' + body.request_id
      expect(body.review_url).toBe(expected)
      expect((await call('get_request', { request_id: body.request_id })).body.review_url).toBe(expected)
      expect([...new URL(body.review_url).searchParams.keys()]).toEqual(['request'])
    }
  })

  it('sends the same signed request as tx and reports approved with the tx hash', async () => {
    const h = await human(approve)
    const { call } = server({ evm: evmPairing(h.room) })
    const sent = await call('request_evm_tx', evmArgs)
    expect(sent.isError).toBe(false)
    const { request_id, status } = sent.body
    expect(status).toBe('pending')
    expect(request_id).toMatch(/^req_/)

    expect(await call('get_request', { request_id, wait_seconds: 5 })).toEqual({ isError: false, body: { request_id, status: 'approved', tx_hash: TX_HASH } })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({
      request_id,
      chain_id: 84532,
      transaction: { to: TO, value: '1000', data: '0x' },
      context: { reason: 'pay the test address', urgency: 'low' },
    })
    expect(typeof h.requests[0].signature).toBe('string')
  })

  it('reports rejected', async () => {
    const h = await human((req) => ({ request_id: req.request_id, status: 'rejected' }))
    const { call } = server({ evm: evmPairing(h.room) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    expect((await call('get_request', { request_id, wait_seconds: 5 })).body).toEqual({ request_id, status: 'rejected' })
  })

  it('reports failed with the wallet error', async () => {
    const h = await human((req) => ({ request_id: req.request_id, status: 'failed', error: 'insufficient funds' }))
    const { call } = server({ evm: evmPairing(h.room) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    const { body } = await call('get_request', { request_id, wait_seconds: 5 })
    expect(body.status).toBe('failed')
    expect(body.error).toContain('insufficient funds')
  })

  it('reports pending without waiting, and expired once the request outlives its ttl', async () => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) }, { requestTtlMs: 400 })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    expect((await call('get_request', { request_id })).body).toMatchObject({ request_id, status: 'pending', expires_at: expect.any(String) })
    expect((await call('get_request', { request_id, wait_seconds: 5 })).body).toEqual({ request_id, status: 'expired' })
    expect((await call('get_request', { request_id })).body).toEqual({ request_id, status: 'expired' })
  })

  it('reports expired, not failed, when the wallet times the request out before anyone asks', async () => {
    const h = await human()
    let options: any
    let walletRequest: Promise<string> | undefined
    const { call } = server({ evm: evmPairing(h.room) }, {
      requestTtlMs: 200,
      onWallet: (wallet) => {
        const requestTx = wallet.requestTx.bind(wallet)
        vi.spyOn(wallet, 'requestTx').mockImplementation((o) => { options = o; return walletRequest = requestTx(o) })
      },
    })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    // the wallet gets the ttl and times out on its own, before any get_request
    expect(options.timeout_ms).toBe(200)
    await expect(walletRequest).rejects.toThrow('timed out after 200ms')
    expect((await call('get_request', { request_id })).body).toEqual({ request_id, status: 'expired' })
  })

  it('reports unknown, not failed, when the relay connection drops after delivery: the human may still approve', async () => {
    const own = await startTestRelay()
    const h = await joinAsHuman(own.url)
    const { call } = server({ evm: evmPairing(h.room, { relay: own.url }) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    await own.close()
    const { body } = await call('get_request', { request_id, wait_seconds: 5 })
    expect(body.status).toBe('unknown')
    expect(body.error).toMatch(/connection closed/)
    expect(body.error).toMatch(/may still approve/)
    expect(body.error).toMatch(/ask .* before sending it again/)
    h.close()
  })

  it('reports failed, not unknown, when the relay refuses the request: nothing reached the human', async () => {
    const refusing = await startTestRelay({ refuseMessages: 'room rate limited' })
    const { call } = server({ evm: evmPairing(toHex(randomBytes(32)), { relay: refusing.url }) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    const { body } = await call('get_request', { request_id, wait_seconds: 5 })
    expect(body).toEqual({ request_id, status: 'failed', error: 'relay error: room rate limited' })
    await refusing.close()
  })

  it('returns from wait_seconds as soon as the human answers', async () => {
    const h = await human(async (req) => {
      await new Promise((r) => setTimeout(r, 300))
      return approve(req)
    })
    const { call } = server({ evm: evmPairing(h.room) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    const started = Date.now()
    expect((await call('get_request', { request_id, wait_seconds: 20 })).body.status).toBe('approved')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it.each([
    ['a placeholder to', { ...evmArgs, to: '0x...' }, 'to'],
    ['a decimal value', { ...evmArgs, value: '0.5' }, 'value'],
    ['a numeric value', { ...evmArgs, value: 1000 }, 'value'],
    ['a string chain id', { ...evmArgs, chain_id: '84532' }, 'chain_id'],
    ['odd-length data', { ...evmArgs, data: '0xabc' }, 'data'],
    ['no reason', { ...evmArgs, reason: undefined }, 'reason'],
    ['an empty reason', { ...evmArgs, reason: '  ' }, 'reason'],
    ['an unknown urgency', { ...evmArgs, urgency: 'asap' }, 'urgency'],
  ])('refuses %s as a tool error and sends nothing', async (_name, args, field) => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) })
    const res = await call('request_evm_tx', args)
    expect(res.isError).toBe(true)
    expect(res.text).toContain(field)
    expect(sentTo(h.room)).toEqual([])
  })

  it('sends from the paired wallet when from names it, in any letter case', async () => {
    const h = await human(approve)
    const wallet = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    const { call } = server({ evm: evmPairing(h.room, { wallet }) })
    const { request_id } = (await call('request_evm_tx', { ...evmArgs, from: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD' })).body
    expect((await call('get_request', { request_id, wait_seconds: 5 })).body).toEqual({ request_id, status: 'approved', tx_hash: TX_HASH })
    expect(h.requests).toHaveLength(1)
    // from picks the pairing; it is nowhere in the request the wallet receives
    expect(JSON.stringify(h.requests[0])).not.toContain('"from"')
  })

  it.each([
    ['another wallet', { from: '0x3333333333333333333333333333333333333333' }, {}, '0x1111111111111111111111111111111111111111'],
    ['a pairing that records no wallet', { from: '0x1111111111111111111111111111111111111111' }, { wallet: null }, 'no wallet address'],
    ['a pairing file without a wallet key', { from: '0x1111111111111111111111111111111111111111' }, { wallet: undefined }, 'no wallet address'],
    // an empty from is a wrong wallet, not an omitted one
    ['an empty string', { from: '' }, {}, '0x1111111111111111111111111111111111111111'],
  ])('refuses from naming %s, naming the paired wallet, and sends nothing', async (_name, extraArgs, pairingExtra, paired) => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room, pairingExtra) })
    const res = await call('request_evm_tx', { ...evmArgs, ...extraArgs })
    expect(res.isError).toBe(true)
    // quoted, so the empty string is checked too
    expect(res.text).toContain(JSON.stringify(extraArgs.from))
    expect(res.text).toContain(paired)
    expect(res.text).toMatch(/nothing was sent/)
    expect(sentTo(h.room)).toEqual([])
  })

  it.each([[123], [null], [['0x1111111111111111111111111111111111111111']]])('refuses a non-string from %j as a tool error and sends nothing', async (from) => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) })
    const res = await call('request_evm_tx', { ...evmArgs, from })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/invalid from/)
    expect(sentTo(h.room)).toEqual([])
  })

  it('refuses when no evm wallet is paired, naming the pairing step', async () => {
    const h = await human()
    const { call } = server({ bitcoin: btcPairing(h.room) })
    const res = await call('request_evm_tx', evmArgs)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/not paired with an evm wallet/)
    expect(res.text).toContain('clanker-wallet pair')
    expect(sentTo(h.room)).toEqual([])
  })

  it('reports an unreachable relay as a tool error naming its url', async () => {
    const { call } = server({ evm: evmPairing(toHex(randomBytes(32)), { relay: 'ws://127.0.0.1:1' }) })
    const res = await call('request_evm_tx', evmArgs)
    expect(res.isError).toBe(true)
    expect(res.text).toContain('ws://127.0.0.1:1')
  })
})

describe('request_transfer', () => {
  it('sends the same signed transfer as send --btc and reports approved', async () => {
    const h = await human(approve)
    const { call } = server({ bitcoin: btcPairing(h.room) })
    const { request_id } = (await call('request_transfer', btcArgs)).body
    expect((await call('get_request', { request_id, wait_seconds: 5 })).body).toEqual({ request_id, status: 'approved', tx_hash: TX_HASH })
    expect(h.requests[0]).toMatchObject({
      request_id,
      chain_family: 'bitcoin',
      chain_network: 'testnet',
      transfer: { asset: 'btc', to: BTC_TEST, amount: '1000' },
      context: { reason: 'pay', expected_outcome: 'paid' },
    })
    expect(h.requests[0].chain_id).toBeUndefined()
  })

  it.each([
    ['an unknown family', { ...btcArgs, family: 'litecoin' }, 'family', {}],
    ['a fee (the wallet sets it)', { ...btcArgs, fee: '10' }, 'fee', {}],
    ['a mainnet address on testnet', { ...btcArgs, to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }, 'to', {}],
    ['a decimal amount', { ...btcArgs, amount: '0.5' }, 'amount', {}],
    ['regtest', { ...btcArgs, network: 'regtest' }, 'network', {}],
    ['another network than the pairing', btcArgs, 'network', { chain_network: 'signet' }],
  ])('refuses %s as a tool error and sends nothing', async (_name, args, field, pairingExtra) => {
    const h = await human()
    const { call } = server({ bitcoin: btcPairing(h.room, pairingExtra) })
    const res = await call('request_transfer', args)
    expect(res.isError).toBe(true)
    expect(res.text).toContain(field)
    expect(sentTo(h.room)).toEqual([])
  })

  it('sends from the paired wallet when from names it, in any letter case', async () => {
    const h = await human(approve)
    const { call } = server({ bitcoin: btcPairing(h.room) })
    const { request_id } = (await call('request_transfer', { ...btcArgs, from: 'TB1ME' })).body
    expect((await call('get_request', { request_id, wait_seconds: 5 })).body).toEqual({ request_id, status: 'approved', tx_hash: TX_HASH })
    expect(h.requests).toHaveLength(1)
    expect(JSON.stringify(h.requests[0])).not.toContain('"from"')
  })

  it('refuses from naming another wallet, naming the paired wallet, and sends nothing', async () => {
    const h = await human()
    const { call } = server({ bitcoin: btcPairing(h.room) })
    const res = await call('request_transfer', { ...btcArgs, from: 'tb1other' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('tb1other')
    expect(res.text).toContain('tb1me')
    expect(res.text).toMatch(/nothing was sent/)
    expect(sentTo(h.room)).toEqual([])
  })

  it('refuses a non-string from as a tool error and sends nothing', async () => {
    const h = await human()
    const { call } = server({ bitcoin: btcPairing(h.room) })
    const res = await call('request_transfer', { ...btcArgs, from: 42 })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/invalid from/)
    expect(sentTo(h.room)).toEqual([])
  })

  it('refuses when no bitcoin wallet is paired', async () => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) })
    const res = await call('request_transfer', btcArgs)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/not paired with a bitcoin wallet/)
    expect(sentTo(h.room)).toEqual([])
  })
})

describe('request_transfer: chia', () => {
  it('sends the same signed transfer as send --xch and reports the tx hash', async () => {
    const h = await human(approve)
    const { call } = server({ chia: chiaPairing(h.room) })
    const { request_id } = (await call('request_transfer', { ...chiaArgs, fee: '50' })).body
    expect((await call('get_request', { request_id, wait_seconds: 5 })).body).toEqual({ request_id, status: 'approved', tx_hash: TX_HASH })
    expect(h.requests[0]).toMatchObject({
      request_id,
      chain_family: 'chia',
      chain_network: 'testnet11',
      transfer: { asset: 'xch', to: TXCH, amount: '1000', fee: '50' },
      context: { reason: 'pay' },
    })
  })

  it('reports approved without a tx hash when the wallet sent without one (Sage)', async () => {
    const h = await human(approveWithoutHash)
    const { call } = server({ chia: chiaPairing(h.room) })
    const { request_id } = (await call('request_transfer', chiaArgs)).body
    expect((await call('get_request', { request_id, wait_seconds: 5 })).body).toEqual({ request_id, status: 'approved' })
    expect(h.requests[0].transfer.fee).toBe('0')
  })

  it('still fails a bitcoin approval without a tx hash', async () => {
    const h = await human(approveWithoutHash)
    const { call } = server({ bitcoin: btcPairing(h.room) })
    const { request_id } = (await call('request_transfer', btcArgs)).body
    const { body } = await call('get_request', { request_id, wait_seconds: 5 })
    expect(body.status).toBe('failed')
    expect(body.tx_hash).toBeUndefined()
  })

  it.each([
    ['a mainnet address on testnet11', { ...chiaArgs, to: XCH }, 'to', {}],
    ['a bitcoin network', { ...chiaArgs, network: 'testnet' }, 'network', {}],
    ['a decimal fee', { ...chiaArgs, fee: '0.5' }, 'fee', {}],
    ['another network than the pairing', chiaArgs, 'network', { chain_network: 'mainnet' }],
  ])('refuses %s as a tool error and sends nothing', async (_name, args, field, pairingExtra) => {
    const h = await human()
    const { call } = server({ chia: chiaPairing(h.room, pairingExtra) })
    const res = await call('request_transfer', args)
    expect(res.isError).toBe(true)
    expect(res.text).toContain(field)
    expect(sentTo(h.room)).toEqual([])
  })

  it('refuses when no chia wallet is paired, pointing at the XCH tab', async () => {
    const h = await human()
    const { call } = server({ bitcoin: btcPairing(h.room) })
    const res = await call('request_transfer', chiaArgs)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/not paired with a chia wallet/)
    expect(res.text).toMatch(/XCH tab/)
    expect(sentTo(h.room)).toEqual([])
  })
})

describe('get_request', () => {
  it('refuses an unknown request id', async () => {
    const { call } = server({})
    const res = await call('get_request', { request_id: 'req_1_abcdef' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/unknown request_id/)
    // it may be from before a restart, and still approvable
    expect(res.text).toMatch(/restart/)
    expect(res.text).toMatch(/may still approve it in their wallet: ask them before sending it again/)
  })

  it('describes expired as the server no longer waiting, not the request being dead', () => {
    const { description } = MCP_TOOLS.find((t) => t.name === 'get_request')!
    expect(description).toMatch(/expired means this server stopped waiting/)
    expect(description).toMatch(/may still approve it in their wallet, so ask them before sending it again/)
    expect(description).not.toMatch(/request expires/i)
  })

  it.each([[-1], ['5'], [Number.NaN]])('refuses wait_seconds %s', async (wait) => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    const res = await call('get_request', { request_id, wait_seconds: wait })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('wait_seconds')
  })

  it(`caps wait_seconds at ${MAX_WAIT_SECONDS}`, async () => {
    const { call } = server({ evm: evmPairing(toHex(randomBytes(32))) }, {
      // a request the human never answers, without a relay, so fake timers can't stall a socket
      onWallet: (wallet) => {
        vi.spyOn(wallet, 'requestTx').mockImplementation(() => {
          setTimeout(() => (wallet as any).emit('request_sent', { request_id: 'req_1_capped' }))
          return new Promise(() => {})
        })
      },
    })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    vi.useFakeTimers()
    try {
      let done = false
      const waiting = call('get_request', { request_id, wait_seconds: 999 }).finally(() => { done = true })
      await vi.advanceTimersByTimeAsync(MAX_WAIT_SECONDS * 1000 - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(done).toBe(true)
      expect((await waiting).body.status).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hold up other calls while it waits', async () => {
    const h = await human()
    const { rpc, call } = server({ evm: evmPairing(h.room) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    const started = Date.now()
    const waiting = call('get_request', { request_id, wait_seconds: 3 })
    expect(await rpc('ping')).toMatchObject({ result: {} })
    expect(Date.now() - started).toBeLessThan(1000)
    expect((await waiting).body.status).toBe('pending')
  })
})

describe('expiry', () => {
  // Date stays real while timers are fake, so a timer fires before Date.now() reaches its target: node's real timers do that by a millisecond
  const fakeTimersOnly = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  /**
   * a server whose wallet reports the request delivered, then never answers, times out after timeout_ms like the real one,
   * or is approved; no relay, so fake timers can't stall a socket
   */
  function stubServer(ttl: number, outcome: 'never' | 'timesOut' | 'approved' = 'never') {
    return server({ evm: evmPairing(toHex(randomBytes(32))) }, {
      requestTtlMs: ttl,
      onWallet: (wallet) => {
        vi.spyOn(wallet, 'requestTx').mockImplementation((o) => new Promise((resolve, reject) => {
          setTimeout(() => {
            (wallet as any).emit('request_sent', { request_id: 'req_1_expiring' })
            if (outcome === 'approved') resolve(TX_HASH)
          })
          if (outcome === 'timesOut') setTimeout(() => reject(new Error(`request req_1_expiring timed out after ${o.timeout_ms}ms`)), o.timeout_ms)
        }))
      },
    })
  }

  async function send(call: ReturnType<typeof server>['call']) {
    const sending = call('request_evm_tx', evmArgs)
    await vi.advanceTimersByTimeAsync(0)
    const { request_id, expires_at } = (await sending).body
    return { request_id: request_id as string, expiresAt: Date.parse(expires_at) }
  }

  it('a get_request waiting through expiry reports expired, even when its timer fires before the clock reaches expires_at', async () => {
    fakeTimersOnly()
    const { call } = stubServer(400)
    const { request_id } = await send(call)
    // at least 1 ms has passed since expires_at was stamped, so a wait timer aimed at expires_at would be set shorter than the ttl and fire first
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1)
    try {
      const waiting = call('get_request', { request_id, wait_seconds: 5 })
      await vi.advanceTimersByTimeAsync(400)
      expect((await waiting).body).toEqual({ request_id, status: 'expired' })
    } finally {
      now.mockRestore()
      vi.useRealTimers()
    }
  })

  it('the wallet timing out at the ttl reports expired, not unknown, even before the clock reaches expires_at', async () => {
    fakeTimersOnly()
    try {
      const { call } = stubServer(400, 'timesOut')
      const { request_id } = await send(call)
      await vi.advanceTimersByTimeAsync(400)
      expect((await call('get_request', { request_id })).body).toEqual({ request_id, status: 'expired' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a get_request handled after expires_at but before the expiry timer has run reports expired', async () => {
    fakeTimersOnly()
    const { call } = stubServer(400)
    const { request_id, expiresAt } = await send(call)
    // a busy process: the clock passes expires_at while the expiry timer has not run yet
    const now = vi.spyOn(Date, 'now').mockReturnValue(expiresAt)
    try {
      expect((await call('get_request', { request_id })).body).toEqual({ request_id, status: 'expired' })
    } finally {
      now.mockRestore()
      vi.useRealTimers()
    }
  })

  it('leaves no expiry timer behind once the request settles', async () => {
    fakeTimersOnly()
    try {
      const { call } = stubServer(400, 'approved')
      const { request_id } = await send(call)
      expect((await call('get_request', { request_id })).body.status).toBe('approved')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('list_pairings', () => {
  it('lists the evm, bitcoin and chia pairings with the agent fingerprint', async () => {
    const { call } = server({
      evm: evmPairing('aa', { mode: 'managed' }),
      bitcoin: btcPairing('bb', { chain_network: 'testnet' }),
      chia: { pubkey: 'cc', relay: relay.url, wallet: 'xch1me', mode: null, chain_family: 'chia' },
    })
    const { body } = await call('list_pairings')
    expect(body.agent_id).toMatch(/^agent_/)
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(body.pairings).toEqual([
      { family: 'evm', network: null, wallet: '0x1111111111111111111111111111111111111111', mode: 'managed' },
      { family: 'bitcoin', network: 'testnet', wallet: 'tb1me', mode: null },
      { family: 'chia', network: null, wallet: 'xch1me', mode: null },
    ])
  })

  it('lists none when nothing is paired', async () => {
    const { call } = server({})
    expect((await call('list_pairings')).body.pairings).toEqual([])
  })
})

describe('join timeout and cancellation', () => {
  let stalled: TestRelay
  let late: TestRelay
  beforeAll(async () => {
    stalled = await startTestRelay({ joinDelayMs: Infinity })
    late = await startTestRelay({ joinDelayMs: 600 })
  })
  afterAll(async () => {
    await stalled.close()
    await late.close()
  })
  const room = () => toHex(randomBytes(32))
  const sentOn = (r: TestRelay) => r.received.filter((m) => m.type === 'message')
  const line = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, params })
  const cancel = (requestId: number) => JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'timed out' } })

  it('passes the wallet a join timeout under the hosts\' 60 s tool-call timeout', async () => {
    const h = await human(approve)
    let options: any
    const { call } = server({ evm: evmPairing(h.room) }, {
      onWallet: (wallet) => {
        const requestTx = wallet.requestTx.bind(wallet)
        vi.spyOn(wallet, 'requestTx').mockImplementation((o) => { options = o; return requestTx(o) })
      },
    })
    expect((await call('request_evm_tx', evmArgs)).isError).toBe(false)
    expect(options.join_timeout_ms).toBeGreaterThan(0)
    expect(options.join_timeout_ms).toBeLessThanOrEqual(30_000)
  })

  it('reports a relay that never answers join as a tool error once the join timeout passes, with nothing sent', async () => {
    const { call } = server({ evm: evmPairing(room(), { relay: stalled.url }) }, { joinTimeoutMs: 300 })
    const started = Date.now()
    const res = await call('request_evm_tx', evmArgs)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/did not answer join.*not sent/)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(sentOn(stalled)).toEqual([])
  })

  it('applies the join timeout to request_transfer too', async () => {
    const { call } = server({ bitcoin: btcPairing(room(), { relay: stalled.url }) }, { joinTimeoutMs: 300 })
    const res = await call('request_transfer', btcArgs)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/did not answer join/)
  })

  it('a cancelled request tool call that has not sent yet sends nothing and gets no reply', async () => {
    const before = sentOn(late).length
    const { mcp } = server({ evm: evmPairing(room(), { relay: late.url }) })
    const pending = mcp.handleLine(line(7, 'tools/call', { name: 'request_evm_tx', arguments: evmArgs }))
    await new Promise((r) => setTimeout(r, 100))
    expect(await mcp.handleLine(cancel(7))).toBeNull()
    expect(await pending).toBeNull()
    await new Promise((r) => setTimeout(r, 800))
    expect(sentOn(late).length).toBe(before)
  })

  it('a cancelled get_request stops waiting and gets no reply', async () => {
    const h = await human()
    const { mcp, call } = server({ evm: evmPairing(h.room) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    const started = Date.now()
    const waiting = mcp.handleLine(line(8, 'tools/call', { name: 'get_request', arguments: { request_id, wait_seconds: 20 } }))
    await new Promise((r) => setTimeout(r, 100))
    await mcp.handleLine(cancel(8))
    expect(await waiting).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
    expect((await call('get_request', { request_id })).body.status).toBe('pending')
  })

  it('ignores a cancel for an id that is not in flight', async () => {
    const { mcp, rpc } = server({})
    expect(await mcp.handleLine(cancel(999))).toBeNull()
    expect(await rpc('ping')).toMatchObject({ result: {} })
  })
})
