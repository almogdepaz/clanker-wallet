import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import nacl from 'tweetnacl'
import { ClankerWallet } from './client.js'
import { decryptMessage, encryptMessage, fromHex, toHex, verifySignature } from './crypto.js'
import type { AgentEnvelope } from './types.js'
import { startTestRelay, type TestRelay } from './testRelay.js'
import { InvalidTxError } from './validate.js'

/**
 * exact bytes of what reaches the human: the decrypted request plaintext and the
 * outer relay frame. fixed keys, clock and request id make both deterministic.
 */

const AGENT_SECRET = new Uint8Array(32).fill(7)
const HUMAN = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9))
const HUMAN_HEX = toHex(HUMAN.publicKey)
const WALLET = '0x1111111111111111111111111111111111111111'
const TO = '0x2222222222222222222222222222222222222222'

let relay: TestRelay

beforeAll(async () => { relay = await startTestRelay() })
afterAll(async () => { await relay?.close() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function freeze(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-02T03:04:05.678Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
}

/** join the human's room, answer the first request with `answer` (approved with a hash by default), return its plaintext and relay frame */
async function capture(
  send: (agent: ClankerWallet) => Promise<string | undefined>,
  pairing: Record<string, unknown>,
  answer: Record<string, unknown> = { status: 'approved', tx_hash: '0xabc' },
) {
  const ws = new WebSocket(relay.url)
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  ws.send(JSON.stringify({ type: 'join', room: HUMAN_HEX }))
  await new Promise((resolve) => ws.addEventListener('message', resolve, { once: true }))

  const seen = new Promise<{ frame: Record<string, unknown>; plaintext: string }>((resolve) => {
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data as string)
      if (frame.type !== 'message') return
      const envelope: AgentEnvelope = JSON.parse(frame.payload)
      const plaintext = decryptMessage(envelope.ciphertext, fromHex(envelope.sender_pubkey), HUMAN.secretKey)!
      const { request_id } = JSON.parse(plaintext)
      const reply: AgentEnvelope = {
        sender_pubkey: HUMAN_HEX,
        ciphertext: encryptMessage(JSON.stringify({ request_id, ...answer }), fromHex(envelope.sender_pubkey), HUMAN.secretKey),
      }
      ws.send(JSON.stringify({ type: 'message', room: HUMAN_HEX, payload: JSON.stringify(reply) }))
      resolve({ frame, plaintext })
    })
  })

  const agent = new ClankerWallet({ secretKey: AGENT_SECRET })
  agent.pair(JSON.stringify({ version: 1, pubkey: HUMAN_HEX, relay: relay.url, ...pairing }))
  let result: string | undefined
  try {
    result = await send(agent)
  } finally {
    // a failed request must not leave the human listening to later tests' frames in the same room
    ws.close()
  }
  const { frame, plaintext } = await seen
  // the agent's frame, not the human's reply
  const sent = relay.received.filter((m) => m.type === 'message' && m.room === HUMAN_HEX && JSON.parse(m.payload).sender_pubkey !== HUMAN_HEX).at(-1)
  const envelope = JSON.parse(sent.payload)
  return { result, frame, plaintext, outer: { ...sent, payload: { ...envelope, ciphertext: '<ciphertext>' } } }
}

describe('evm request wire format (characterization)', () => {
  const evmTx = (agent: ClankerWallet) => agent.requestTx({
    chain_id: 84532,
    transaction: { to: TO, value: 5n, data: '0xabcd' },
    context: { reason: 'pay', urgency: 'low', expected_outcome: 'paid' },
    timeout_ms: 10_000,
  })

  test('encrypted pairing', async () => {
    freeze()
    const { result, plaintext, outer } = await capture(evmTx, { wallet: WALLET })
    expect(result).toBe('0xabc')
    expect(plaintext).toBe(EVM_PLAINTEXT)
    expect(outer).toEqual({
      type: 'message',
      room: HUMAN_HEX,
      payload: { sender_pubkey: AGENT_PUBKEY, ciphertext: '<ciphertext>', signing_pubkey: AGENT_SIGNING_PUBKEY },
    })
  })

  test('managed pairing', async () => {
    freeze()
    const { plaintext, outer } = await capture(evmTx, { wallet: WALLET, mode: 'managed' })
    expect(plaintext).toBe(EVM_PLAINTEXT)
    expect(outer).toEqual({
      type: 'message',
      room: HUMAN_HEX,
      payload: { sender_pubkey: AGENT_PUBKEY, ciphertext: '<ciphertext>', signing_pubkey: AGENT_SIGNING_PUBKEY },
      simulate: { from: WALLET, to: TO, value: '5', data: '0xabcd', chainId: 84532 },
    })
  })

  test('an explicit evm chain_family sends the same bytes', async () => {
    freeze()
    const { plaintext } = await capture(evmTx, { wallet: WALLET, chain_family: 'evm' })
    expect(plaintext).toBe(EVM_PLAINTEXT)
  })

  test.each(['bitcoin', 'chia'])('rejects a %s pairing before connecting to the relay', async (family) => {
    const agent = new ClankerWallet({ secretKey: AGENT_SECRET })
    const room = toHex(nacl.box.keyPair().publicKey)
    agent.pair(JSON.stringify({ version: 1, pubkey: room, relay: relay.url, chain_family: family }))
    const err = await evmTx(agent).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidTxError)
    expect((err as InvalidTxError).field).toBe('chain_family')
    expect(relay.received.filter((m) => m.room === room)).toEqual([])
  })
})

describe('transfer request wire format', () => {
  const TXCH = 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg'
  const BTC_TEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'

  test('chia: chain_family from the pairing, no chain_id or transaction, fee defaults to 0', async () => {
    freeze()
    const { result, plaintext, outer } = await capture((agent) => agent.requestTransfer({
      chain_network: 'testnet11',
      transfer: { asset: 'xch', to: TXCH, amount: 5n },
      context: { reason: 'pay' },
      timeout_ms: 10_000,
    }), { wallet: 'xch1wallet', chain_family: 'chia', mode: 'managed' })

    expect(result).toBe('0xabc')
    const req = JSON.parse(plaintext)
    expect(Object.keys(req)).toEqual(['request_id', 'agent_id', 'timestamp', 'chain_family', 'chain_network', 'transfer', 'context', 'signature'])
    expect(req).toMatchObject({
      request_id: 'req_1767323045678_4fzzzx',
      agent_id: 'agent_13be4feaeaf2',
      timestamp: '2026-01-02T03:04:05.678Z',
      chain_family: 'chia',
      chain_network: 'testnet11',
      transfer: { asset: 'xch', to: TXCH, amount: '5', fee: '0' },
      context: { reason: 'pay' },
    })
    // the web verifies over the received object with the signature blanked in place
    expect(verifySignature(JSON.stringify({ ...req, signature: '' }), req.signature, fromHex(AGENT_SIGNING_PUBKEY))).toBe(true)
    // the relay simulator is evm-only: a managed pairing sends no simulate object for transfers
    expect(outer).toEqual({
      type: 'message',
      room: HUMAN_HEX,
      payload: { sender_pubkey: AGENT_PUBKEY, ciphertext: '<ciphertext>', signing_pubkey: AGENT_SIGNING_PUBKEY },
    })
  })

  test('bitcoin: no fee key, no context key when none is given', async () => {
    const { plaintext } = await capture((agent) => agent.requestTransfer({
      chain_network: 'testnet',
      transfer: { asset: 'btc', to: BTC_TEST, amount: '1000' },
      timeout_ms: 10_000,
    }), { wallet: 'tb1wallet', chain_family: 'bitcoin' })
    const req = JSON.parse(plaintext)
    expect(req.transfer).toEqual({ asset: 'btc', to: BTC_TEST, amount: '1000' })
    expect(Object.keys(req)).toEqual(['request_id', 'agent_id', 'timestamp', 'chain_family', 'chain_network', 'transfer', 'signature'])
  })

  // Sage's chia_send sends and reports no transaction id: the approval comes without tx_hash
  test('chia: an approval without tx_hash resolves with no hash', async () => {
    const { result } = await capture((agent) => agent.requestTransfer({
      chain_network: 'testnet11',
      transfer: { asset: 'xch', to: TXCH, amount: '1' },
      timeout_ms: 10_000,
    }), { wallet: 'xch1wallet', chain_family: 'chia' }, { status: 'approved' })
    expect(result).toBeUndefined()
  })

  test('bitcoin and evm: an approval without tx_hash is still a failure', async () => {
    await expect(capture((agent) => agent.requestTransfer({
      chain_network: 'testnet',
      transfer: { asset: 'btc', to: BTC_TEST, amount: '1000' },
      timeout_ms: 10_000,
    }), { wallet: 'tb1wallet', chain_family: 'bitcoin' }, { status: 'approved' })).rejects.toThrow('unexpected response status "approved"')
    await expect(capture((agent) => agent.requestTx({
      chain_id: 84532,
      transaction: { to: TO, value: 5n, data: '0x' },
      timeout_ms: 10_000,
    }), { wallet: WALLET }, { status: 'approved' })).rejects.toThrow('unexpected response status "approved"')
  })

  test.each([
    ['an evm pairing', {}, 'testnet11', 'chain_family'],
    ['a pairing on another network', { chain_family: 'chia', chain_network: 'mainnet' }, 'testnet11', 'chain_network'],
    ['a recipient on another network', { chain_family: 'chia' }, 'mainnet', 'to'],
  ])('rejects %s before connecting to the relay', async (_name, pairing, network, field) => {
    const agent = new ClankerWallet({ secretKey: AGENT_SECRET })
    const room = toHex(nacl.box.keyPair().publicKey)
    agent.pair(JSON.stringify({ version: 1, pubkey: room, relay: relay.url, ...pairing }))
    const err = await agent.requestTransfer({ chain_network: network, transfer: { asset: 'xch', to: TXCH, amount: '1' } })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidTxError)
    expect((err as InvalidTxError).field).toBe(field)
    expect(relay.received.filter((m) => m.room === room)).toEqual([])
  })

  test('requestTransfer() throws if not paired', async () => {
    await expect(new ClankerWallet().requestTransfer({ chain_network: 'testnet11', transfer: { asset: 'xch', to: TXCH, amount: '1' } }))
      .rejects.toThrow('not paired')
  })

  test('pair() keeps chain_family and chain_network', () => {
    const data = new ClankerWallet().pair(JSON.stringify({ version: 1, pubkey: 'aa', relay: 'ws://x', chain_family: 'bitcoin', chain_network: 'signet' }))
    expect(data).toMatchObject({ chain_family: 'bitcoin', chain_network: 'signet' })
  })
})

describe('signature request wire format', () => {
  const signature = '0x' + 'ab'.repeat(65)
  const typed_data = { domain: { chainId: 1 }, types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Mail: [{ name: 'text', type: 'string' }] }, primaryType: 'Mail', message: { text: 'hello' } }
  test.each(['encrypted', 'managed'])('%s signs and encrypts both methods, never simulates', async mode => {
    for (const method of ['personal_sign', 'eth_signTypedData_v4']) {
      const { result, plaintext, outer } = await capture(agent => method === 'personal_sign'
        ? agent.requestSignMessage({ chain_id: 1, message: '0x00ff', context: { reason: 'login' }, timeout_ms: 1000 })
        : agent.requestSignTypedData({ chain_id: 1, typed_data, timeout_ms: 1000 }), { wallet: WALLET, mode }, { status: 'approved', signature, tx_hash: 'wrong-result' })
      expect(result).toBe(signature)
      const req = JSON.parse(plaintext)
      expect(req.sign).toEqual(method === 'personal_sign' ? { method, message: '0x00ff' } : { method, typed_data })
      expect(req.transaction).toBeUndefined()
      expect(verifySignature(JSON.stringify({ ...req, signature: '' }), req.signature, fromHex(AGENT_SIGNING_PUBKEY))).toBe(true)
      expect(outer).not.toHaveProperty('simulate')
    }
  })
  test.each([undefined, '0x1234', 'ab'.repeat(65)])('refuses an approval without a valid signature: %s', async signature => {
    await expect(capture(agent => agent.requestSignMessage({ chain_id: 1, message: 'hello', timeout_ms: 1000 }), { wallet: WALLET }, { status: 'approved', signature, tx_hash: '0xabc' })).rejects.toThrow(/signature/)
  })
  test('maximum payload and whole request fit the relay frame after signing, encryption, base64 and envelope', async () => {
    freeze()
    const message = 'a'.repeat(32766)
    const shell = { request_id: 'req_1767323045678_4fzzzx', agent_id: 'agent_13be4feaeaf2', timestamp: '2026-01-02T03:04:05.678Z', chain_id: 1, sign: { method: 'personal_sign', message }, context: { reason: '' }, signature: 'a'.repeat(88) }
    const reason = 'x'.repeat(40000 - new TextEncoder().encode(JSON.stringify(shell)).length)
    const { outer, plaintext } = await capture(agent => agent.requestSignMessage({ chain_id: 1, message, context: { reason }, timeout_ms: 1000 }), { wallet: WALLET, mode: 'managed' }, { status: 'approved', signature })
    expect(new TextEncoder().encode(plaintext).length).toBe(40000)
    const sent = relay.received.filter(m => m.type === 'message' && m.room === HUMAN_HEX && JSON.parse(m.payload).sender_pubkey !== HUMAN_HEX).at(-1)
    expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBeLessThanOrEqual(65536)
    expect(outer).not.toHaveProperty('simulate')
  })
  test('snapshots original typed payload and context before waiting for relay join', async () => {
    const { plaintext } = await capture(agent => {
      const data = JSON.parse(JSON.stringify(typed_data))
      const context = { reason: 'original reason' }
      const result = agent.requestSignTypedData({ chain_id: 1, typed_data: data, context, timeout_ms: 1000 })
      data.message.text = 'changed after request'
      context.reason = 'changed after request'
      return result
    }, { wallet: WALLET }, { status: 'approved', signature })
    const req = JSON.parse(plaintext)
    expect(req.sign.typed_data).toEqual(typed_data)
    expect(req.context.reason).toBe('original reason')
    expect(verifySignature(JSON.stringify({ ...req, signature: '' }), req.signature, fromHex(AGENT_SIGNING_PUBKEY))).toBe(true)
  })
  test.each(['requestSignMessage', 'requestSignTypedData'] as const)('%s handles cancellation before sending', async method => {
    const agent = new ClankerWallet()
    await expect(method === 'requestSignMessage' ? agent.requestSignMessage({ chain_id: 1, message: 'hello' }) : agent.requestSignTypedData({ chain_id: 1, typed_data })).rejects.toThrow(/not paired/)
    const room = toHex(nacl.box.keyPair().publicKey)
    agent.pair(JSON.stringify({ version: 1, pubkey: room, relay: relay.url }))
    const options = { chain_id: 1, signal: AbortSignal.abort() }
    await expect(method === 'requestSignMessage' ? agent.requestSignMessage({ ...options, message: 'hello' }) : agent.requestSignTypedData({ ...options, typed_data })).rejects.toThrow(/cancelled/)
    expect(relay.received.filter(m => m.room === room)).toEqual([])
  })
  test.each([{ status: 'rejected' }, { status: 'failed', error: 'wallet cancelled' }])('does not resolve rejected/failed answers: %s', async answer => {
    await expect(capture(agent => agent.requestSignMessage({ chain_id: 1, message: 'hello', timeout_ms: 1000 }), { wallet: WALLET }, answer)).rejects.toThrow(/rejected by human|wallet cancelled/)
  })
  test.each(['bitcoin', 'chia'])('refuses %s before connection', async chain_family => {
    const agent = new ClankerWallet()
    const room = toHex(nacl.box.keyPair().publicKey)
    agent.pair(JSON.stringify({ version: 1, pubkey: room, relay: relay.url, chain_family }))
    await expect(agent.requestSignMessage({ chain_id: 1, message: 'hello' })).rejects.toThrow(/EVM pairing/)
    await expect(agent.requestSignTypedData({ chain_id: 1, typed_data })).rejects.toThrow(/EVM pairing/)
    expect(relay.received.filter(m => m.room === room)).toEqual([])
  })
  test('refuses excessive context before connection', async () => {
    const agent = new ClankerWallet()
    const room = toHex(nacl.box.keyPair().publicKey)
    agent.pair(JSON.stringify({ version: 1, pubkey: room, relay: relay.url }))
    await expect(agent.requestSignMessage({ chain_id: 1, message: 'hello', context: { reason: 'x'.repeat(40000) } })).rejects.toThrow(/bytes/)
    expect(relay.received.filter(m => m.room === room)).toEqual([])
  })
})

const AGENT_PUBKEY = '13be4feaeaf204c7fd3358fc9c00721881d174278128227ec674f37f7fe97b6d'
const AGENT_SIGNING_PUBKEY = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c'
/** 0.4.2 requestTx output; must not change */
const EVM_PLAINTEXT = '{"request_id":"req_1767323045678_4fzzzx","agent_id":"agent_13be4feaeaf2","timestamp":"2026-01-02T03:04:05.678Z","chain_id":84532,"transaction":{"to":"0x2222222222222222222222222222222222222222","value":"5","data":"0xabcd"},"context":{"reason":"pay","urgency":"low","expected_outcome":"paid"},"signature":"5bLWTeCYoToJnUfBEoAoCiYIDYnFNp7NDZadXa3yJWjb1ESKy51y2zo0chi+VwT9T7z0bXsRzL+iaR7WvHN0Bg=="}'
