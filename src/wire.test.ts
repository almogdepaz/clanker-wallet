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

/** join the human's room, approve the first request, return its plaintext and relay frame */
async function capture(send: (agent: ClankerWallet) => Promise<string>, pairing: Record<string, unknown>) {
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
        ciphertext: encryptMessage(JSON.stringify({ request_id, status: 'approved', tx_hash: '0xabc' }), fromHex(envelope.sender_pubkey), HUMAN.secretKey),
      }
      ws.send(JSON.stringify({ type: 'message', room: HUMAN_HEX, payload: JSON.stringify(reply) }))
      resolve({ frame, plaintext })
    })
  })

  const agent = new ClankerWallet({ secretKey: AGENT_SECRET })
  agent.pair(JSON.stringify({ version: 1, pubkey: HUMAN_HEX, relay: relay.url, ...pairing }))
  const result = await send(agent)
  const { frame, plaintext } = await seen
  ws.close()
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

const AGENT_PUBKEY = '13be4feaeaf204c7fd3358fc9c00721881d174278128227ec674f37f7fe97b6d'
const AGENT_SIGNING_PUBKEY = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c'
/** 0.4.2 requestTx output; must not change */
const EVM_PLAINTEXT = '{"request_id":"req_1767323045678_4fzzzx","agent_id":"agent_13be4feaeaf2","timestamp":"2026-01-02T03:04:05.678Z","chain_id":84532,"transaction":{"to":"0x2222222222222222222222222222222222222222","value":"5","data":"0xabcd"},"context":{"reason":"pay","urgency":"low","expected_outcome":"paid"},"signature":"5bLWTeCYoToJnUfBEoAoCiYIDYnFNp7NDZadXa3yJWjb1ESKy51y2zo0chi+VwT9T7z0bXsRzL+iaR7WvHN0Bg=="}'
