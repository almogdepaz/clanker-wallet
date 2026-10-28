import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { ClankerWallet } from './client.js'
import { toHex } from './crypto.js'
import { createMcpServer, MAX_WAIT_SECONDS, MCP_TOOLS, type SavedPairing } from './mcp.js'
import { joinAsHuman, startTestRelay, type TestHuman, type TestRelay } from './testRelay.js'

const TO = '0x2222222222222222222222222222222222222222'
const BTC_TEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
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

/** an mcp server for one agent identity, paired per family as given (the cli wires its own pairing files the same way) */
function server(pairings: Partial<Record<string, SavedPairing>>, requestTtlMs?: number) {
  const secretKey = new Uint8Array(randomBytes(32))
  const identity = new ClankerWallet({ secretKey })
  const mcp = createMcpServer({
    version: '9.9.9',
    identity: { agent_id: identity.agentId, fingerprint: toHex(identity.publicKey).slice(0, 16) },
    loadPairing: (family) => pairings[family] ?? null,
    wallet: (pairing) => {
      const wallet = new ClankerWallet({ secretKey })
      wallet.pair(JSON.stringify({ version: 1, ...pairing }))
      return wallet
    },
    requestTtlMs,
  })
  let nextId = 1
  const rpc = async (method: string, params?: unknown) => {
    const reply = await mcp.handleLine(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }))
    return JSON.parse(reply!)
  }
  /** a tools/call result: `isError` and the parsed text payload (or the error text) */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const { result } = await rpc('tools/call', { name, arguments: args })
    const text = result.content[0].text
    return result.isError ? { isError: true, text } : { isError: false, body: JSON.parse(text) }
  }
  return { mcp, rpc, call }
}

const evmPairing = (room: string, extra: Partial<SavedPairing> = {}): SavedPairing =>
  ({ pubkey: room, relay: relay.url, wallet: '0x1111111111111111111111111111111111111111', mode: null, ...extra })
const btcPairing = (room: string, extra: Partial<SavedPairing> = {}): SavedPairing =>
  ({ pubkey: room, relay: relay.url, wallet: 'tb1me', mode: null, chain_family: 'bitcoin', ...extra })

const evmArgs = { chain_id: 84532, to: TO, value: '1000', reason: 'pay the test address', urgency: 'low' }
const sentTo = (room: string) => relay.received.filter((m) => m.type === 'message' && m.room === room)

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

  it('lists the four tools with object schemas, stating human approval and integer-string amounts', async () => {
    const { result } = await rpc('tools/list')
    expect(result.tools.map((t: any) => t.name)).toEqual(['request_evm_tx', 'request_transfer', 'get_request', 'list_pairings'])
    for (const tool of result.tools) expect(tool.inputSchema.type).toBe('object')
    const byName = Object.fromEntries(result.tools.map((t: any) => [t.name, t]))
    for (const name of ['request_evm_tx', 'request_transfer']) {
      expect(byName[name].description).toMatch(/human approves every request on their (own )?device/i)
      expect(byName[name].description).toMatch(/integer string/i)
    }
    expect(byName.request_evm_tx.description).toContain('wei')
    expect(byName.request_transfer.description).toContain('sats')
    expect(byName.get_request.inputSchema.properties.wait_seconds.maximum).toBe(MAX_WAIT_SECONDS)
    expect(MAX_WAIT_SECONDS).toBeLessThanOrEqual(50)
    expect(result.tools).toEqual(MCP_TOOLS)
  })
})

describe('request_evm_tx + get_request', () => {
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
    const { call } = server({ evm: evmPairing(h.room) }, 400)
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    expect((await call('get_request', { request_id })).body).toMatchObject({ request_id, status: 'pending', expires_at: expect.any(String) })
    expect((await call('get_request', { request_id, wait_seconds: 5 })).body).toEqual({ request_id, status: 'expired' })
    expect((await call('get_request', { request_id })).body).toEqual({ request_id, status: 'expired' })
  })

  it('reports expired, not failed, when the wallet times the request out before anyone asks', async () => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) }, 200)
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    await new Promise((r) => setTimeout(r, 600))
    expect((await call('get_request', { request_id })).body).toEqual({ request_id, status: 'expired' })
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
  const btcArgs = { family: 'bitcoin', network: 'testnet', to: BTC_TEST, amount: '1000', reason: 'pay', expected_outcome: 'paid' }

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
    ['chia', { ...btcArgs, family: 'chia' }, 'family', {}],
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

  it('refuses when no bitcoin wallet is paired', async () => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) })
    const res = await call('request_transfer', btcArgs)
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/not paired with a bitcoin wallet/)
    expect(sentTo(h.room)).toEqual([])
  })
})

describe('get_request', () => {
  it('refuses an unknown request id', async () => {
    const { call } = server({})
    const res = await call('get_request', { request_id: 'req_1_abcdef' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/unknown request_id/)
  })

  it.each([[-1], ['5'], [Number.NaN]])('refuses wait_seconds %s', async (wait) => {
    const h = await human()
    const { call } = server({ evm: evmPairing(h.room) })
    const { request_id } = (await call('request_evm_tx', evmArgs)).body
    const res = await call('get_request', { request_id, wait_seconds: wait })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('wait_seconds')
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

describe('list_pairings', () => {
  it('lists the evm and bitcoin pairings with the agent fingerprint, not chia', async () => {
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
    ])
  })

  it('lists none when nothing is paired', async () => {
    const { call } = server({})
    expect((await call('list_pairings')).body.pairings).toEqual([])
  })
})
