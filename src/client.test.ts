import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import nacl from 'tweetnacl'
import { ClankerWallet } from './client.js'
import { encryptMessage, decryptMessage, toHex, fromHex } from './crypto.js'
import type { AgentEnvelope, TxRequest, TxResponse } from './types.js'

const PORT = 9877
let serverProc: ChildProcess

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForServerReady(maxAttempts = 20): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`)
      if (res.ok) return
    } catch {
      // not ready
    }
    await sleep(250)
  }
  throw new Error('server failed to start')
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve()
    const timeout = setTimeout(() => reject(new Error('timeout')), 5000)
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('ws error')) }, { once: true })
  })
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for message')), 10000)
    ws.addEventListener('message', (event) => {
      clearTimeout(timeout)
      resolve(JSON.parse(event.data as string))
    }, { once: true })
  })
}

/** simulate the human side: connect to relay, listen for requests, respond */
async function simulateHuman(
  humanKeypair: nacl.BoxKeyPair,
  relayUrl: string,
  respond: (req: TxRequest, agentPubkey: string) => TxResponse | null,
): Promise<{ ws: WebSocket; received: TxRequest[] }> {
  const humanPubkeyHex = toHex(humanKeypair.publicKey)
  const ws = new WebSocket(relayUrl)
  await waitForOpen(ws)

  ws.send(JSON.stringify({ type: 'join', room: humanPubkeyHex }))
  await waitForMessage(ws) // joined ack

  const received: TxRequest[] = []

  ws.addEventListener('message', (event) => {
    let msg: any
    try { msg = JSON.parse(event.data as string) } catch { return }
    if (msg.type !== 'message') return

    try {
      const envelope: AgentEnvelope = JSON.parse(msg.payload)
      const plaintext = decryptMessage(
        envelope.ciphertext,
        fromHex(envelope.sender_pubkey),
        humanKeypair.secretKey,
      )
      if (!plaintext) return

      const txReq: TxRequest = JSON.parse(plaintext)
      received.push(txReq)

      const response = respond(txReq, envelope.sender_pubkey)
      if (!response) return

      // encrypt and send back
      const ciphertext = encryptMessage(
        JSON.stringify(response),
        fromHex(envelope.sender_pubkey),
        humanKeypair.secretKey,
      )
      const respEnvelope: AgentEnvelope = {
        sender_pubkey: humanPubkeyHex,
        ciphertext,
      }
      ws.send(JSON.stringify({
        type: 'message',
        room: humanPubkeyHex,
        payload: JSON.stringify(respEnvelope),
      }))
    } catch {
      // ignore
    }
  })

  return { ws, received }
}

beforeAll(async () => {
  const relayDir = resolve(import.meta.dirname!, '../../relay')

  serverProc = spawn('bun', ['src/server.ts'], {
    cwd: relayDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  })

  serverProc.stderr?.on('data', (d) => process.stderr.write(d))

  await waitForServerReady()
}, 15000)

afterAll(() => {
  serverProc?.kill('SIGINT')
})

describe('ClankerWallet SDK', () => {
  const relayUrl = `ws://localhost:${PORT}/ws`

  test('generates unique agent ID from keypair', () => {
    const w1 = new ClankerWallet()
    const w2 = new ClankerWallet()
    expect(w1.agentId).toMatch(/^agent_[0-9a-f]{12}$/)
    expect(w1.agentId).not.toBe(w2.agentId)
  })

  test('restores keypair from secret key', () => {
    const w1 = new ClankerWallet()
    const w2 = new ClankerWallet({ secretKey: w1.secretKey })
    expect(toHex(w2.publicKey)).toBe(toHex(w1.publicKey))
    expect(w2.agentId).toBe(w1.agentId)
  })

  test('pair() parses QR data', () => {
    const wallet = new ClankerWallet()
    expect(wallet.paired).toBe(false)

    const qrData = JSON.stringify({
      version: 1,
      pubkey: 'aabbccdd',
      relay: relayUrl,
      wallet: '0x1234',
    })
    const data = wallet.pair(qrData)

    expect(wallet.paired).toBe(true)
    expect(data.pubkey).toBe('aabbccdd')
    expect(data.relay).toBe(relayUrl)
    expect(data.wallet).toBe('0x1234')
  })

  test('pair() rejects invalid version', () => {
    const wallet = new ClankerWallet()
    expect(() => wallet.pair(JSON.stringify({ version: 99, pubkey: 'aa', relay: 'ws://x' })))
      .toThrow('unsupported pairing version')
  })

  test('pair() rejects missing fields', () => {
    const wallet = new ClankerWallet()
    expect(() => wallet.pair(JSON.stringify({ version: 1 })))
      .toThrow('missing pubkey or relay')
  })

  test('requestTx() throws if not paired', async () => {
    const wallet = new ClankerWallet()
    await expect(wallet.requestTx({
      chain_id: 1,
      transaction: { to: '0x0', value: '0', data: '0x' },
    })).rejects.toThrow('not paired')
  })

  test('full flow: agent sends tx request, human approves', async () => {
    const humanKeypair = nacl.box.keyPair()
    const humanPubkeyHex = toHex(humanKeypair.publicKey)

    // human joins room and auto-approves
    const { ws: humanWs, received } = await simulateHuman(
      humanKeypair,
      relayUrl,
      (req) => ({
        request_id: req.request_id,
        status: 'approved' as const,
        tx_hash: '0xdeadbeef1234',
      }),
    )

    // agent pairs and sends request
    const agent = new ClankerWallet()
    agent.pair(JSON.stringify({
      version: 1,
      pubkey: humanPubkeyHex,
      relay: relayUrl,
      wallet: '0xhuman',
    }))

    const txHash = await agent.requestTx({
      chain_id: 11155111,
      transaction: {
        to: '0xrecipient',
        value: '1000000000000000',
        data: '0x',
      },
      context: {
        reason: 'test transfer',
        urgency: 'normal',
      },
      timeout_ms: 10000,
    })

    expect(txHash).toBe('0xdeadbeef1234')
    expect(received).toHaveLength(1)
    expect(received[0].chain_id).toBe(11155111)
    expect(received[0].transaction.to).toBe('0xrecipient')
    expect(received[0].context?.reason).toBe('test transfer')
    expect(received[0].agent_id).toBe(agent.agentId)

    humanWs.close()
  })

  test('full flow: agent sends tx request, human rejects', async () => {
    const humanKeypair = nacl.box.keyPair()
    const humanPubkeyHex = toHex(humanKeypair.publicKey)

    const { ws: humanWs } = await simulateHuman(
      humanKeypair,
      relayUrl,
      (req) => ({
        request_id: req.request_id,
        status: 'rejected' as const,
      }),
    )

    const agent = new ClankerWallet()
    agent.pair(JSON.stringify({
      version: 1,
      pubkey: humanPubkeyHex,
      relay: relayUrl,
      wallet: '0xhuman',
    }))

    await expect(agent.requestTx({
      chain_id: 1,
      transaction: { to: '0xrecipient', value: '0', data: '0x' },
      timeout_ms: 10000,
    })).rejects.toThrow('rejected by human')

    humanWs.close()
  })

  test('requestTx() times out if no response', async () => {
    const humanKeypair = nacl.box.keyPair()
    const humanPubkeyHex = toHex(humanKeypair.publicKey)

    // human joins but never responds
    const { ws: humanWs } = await simulateHuman(
      humanKeypair,
      relayUrl,
      () => null,
    )

    const agent = new ClankerWallet()
    agent.pair(JSON.stringify({
      version: 1,
      pubkey: humanPubkeyHex,
      relay: relayUrl,
      wallet: '0xhuman',
    }))

    await expect(agent.requestTx({
      chain_id: 1,
      transaction: { to: '0x0', value: '0', data: '0x' },
      timeout_ms: 1500,
    })).rejects.toThrow('timed out')

    humanWs.close()
  })

  test('encryption is end-to-end: relay sees only ciphertext', async () => {
    const humanKeypair = nacl.box.keyPair()
    const humanPubkeyHex = toHex(humanKeypair.publicKey)

    // spy on relay traffic
    const spy = new WebSocket(relayUrl)
    await waitForOpen(spy)
    spy.send(JSON.stringify({ type: 'join', room: humanPubkeyHex }))
    await waitForMessage(spy) // joined ack

    const relayMessages: any[] = []
    spy.addEventListener('message', (event) => {
      try { relayMessages.push(JSON.parse(event.data as string)) } catch {}
    })

    const { ws: humanWs } = await simulateHuman(
      humanKeypair,
      relayUrl,
      (req) => ({
        request_id: req.request_id,
        status: 'approved' as const,
        tx_hash: '0xabc',
      }),
    )

    const agent = new ClankerWallet()
    agent.pair(JSON.stringify({
      version: 1,
      pubkey: humanPubkeyHex,
      relay: relayUrl,
      wallet: '0xhuman',
    }))

    await agent.requestTx({
      chain_id: 1,
      transaction: { to: '0xsecret', value: '999', data: '0xdeadbeef' },
      timeout_ms: 10000,
    })

    await sleep(200)

    // relay messages should contain ciphertext, NOT plaintext
    const payloads = relayMessages
      .filter((m) => m.type === 'message')
      .map((m) => m.payload)

    for (const payload of payloads) {
      expect(payload).not.toContain('0xsecret')
      expect(payload).not.toContain('0xdeadbeef')
      // should be AgentEnvelope with ciphertext
      const env: AgentEnvelope = JSON.parse(payload)
      expect(env.sender_pubkey).toBeTruthy()
      expect(env.ciphertext).toBeTruthy()
    }

    spy.close()
    humanWs.close()
  })
})
