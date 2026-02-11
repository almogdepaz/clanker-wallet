import { encryptMessage, decryptMessage, toHex, fromHex, generateKeypair, keypairFromSecret, signingKeypairFromSeed, signMessage } from './crypto.js'
import { TypedEmitter } from './events.js'
import type { PairingData, RequestTxOptions, TxRequest, TxResponse, AgentEnvelope } from './types.js'

const DEFAULT_TIMEOUT_MS = 3_600_000 // 1 hour

export interface ClankerWalletOptions {
  /** agent display name (informational) */
  agentName?: string
  /** 32-byte secret key to restore identity. if omitted, generates a new keypair. */
  secretKey?: Uint8Array
}

export class ClankerWallet extends TypedEmitter {
  readonly publicKey: Uint8Array
  readonly secretKey: Uint8Array
  readonly agentId: string
  /** Ed25519 public key for signing TxRequests */
  readonly signingPublicKey: Uint8Array
  private readonly signingSecretKey: Uint8Array

  private humanPubkey: Uint8Array | null = null
  private humanPubkeyHex: string | null = null
  private relayUrl: string | null = null
  private humanWallet: string | null = null

  constructor(options: ClankerWalletOptions = {}) {
    super()
    const kp = options.secretKey
      ? keypairFromSecret(options.secretKey)
      : generateKeypair()

    this.publicKey = kp.publicKey
    this.secretKey = kp.secretKey
    this.agentId = `agent_${toHex(kp.publicKey).slice(0, 12)}`

    // derive Ed25519 signing keypair from the x25519 secret key (first 32 bytes = seed)
    const signingKp = signingKeypairFromSeed(kp.secretKey)
    this.signingPublicKey = signingKp.publicKey
    this.signingSecretKey = signingKp.secretKey
  }

  /** whether this agent has been paired with a human */
  get paired(): boolean {
    return this.humanPubkey !== null
  }

  /** parse QR/pairing data and store the human's pubkey + relay url */
  pair(qrData: string): PairingData {
    const data: PairingData = JSON.parse(qrData)

    if (data.version !== 1) {
      throw new Error(`unsupported pairing version: ${data.version}`)
    }
    if (!data.pubkey || !data.relay) {
      throw new Error('invalid pairing data: missing pubkey or relay')
    }

    this.humanPubkey = fromHex(data.pubkey)
    this.humanPubkeyHex = data.pubkey
    this.relayUrl = data.relay
    this.humanWallet = data.wallet || null

    this.emit('paired', { relay: data.relay, wallet: data.wallet || '' })

    return data
  }

  /**
   * send a transaction request to the paired human and wait for their response.
   * resolves with tx hash on approval.
   * throws on rejection, timeout, or connection error.
   */
  async requestTx(options: RequestTxOptions): Promise<string> {
    if (!this.humanPubkey || !this.humanPubkeyHex || !this.relayUrl) {
      throw new Error('not paired — call pair() first')
    }

    const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const txRequest: TxRequest = {
      request_id: requestId,
      agent_id: this.agentId,
      timestamp: new Date().toISOString(),
      chain_id: options.chain_id,
      transaction: options.transaction,
      context: options.context,
      signature: '', // set below after signing
    }

    // sign the request (signature field empty during signing, then filled)
    const sigPayload = JSON.stringify(txRequest)
    txRequest.signature = signMessage(sigPayload, this.signingSecretKey)

    const humanPubkey = this.humanPubkey
    const humanPubkeyHex = this.humanPubkeyHex
    const relayUrl = this.relayUrl
    const secretKey = this.secretKey
    const agentPubkeyHex = toHex(this.publicKey)
    const signingPubkeyHex = toHex(this.signingPublicKey)

    return new Promise<string>((resolve, reject) => {
      let ws: WebSocket
      let timer: ReturnType<typeof setTimeout>
      let settled = false

      const cleanup = () => {
        settled = true
        clearTimeout(timer)
        if (ws && ws.readyState <= WebSocket.OPEN) {
          ws.close()
        }
      }

      timer = setTimeout(() => {
        if (!settled) {
          cleanup()
          this.emit('error', { message: `request ${requestId} timed out after ${timeoutMs}ms` })
          reject(new Error(`request ${requestId} timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      this.emit('connecting', { relay: relayUrl })

      try {
        ws = new WebSocket(relayUrl)
      } catch (err) {
        cleanup()
        this.emit('error', { message: `failed to connect to relay: ${err}` })
        reject(new Error(`failed to connect to relay: ${err}`))
        return
      }

      ws.addEventListener('error', () => {
        if (!settled) {
          cleanup()
          this.emit('error', { message: 'relay connection error' })
          reject(new Error('relay connection error'))
        }
      })

      ws.addEventListener('close', () => {
        this.emit('disconnected', {})
        if (!settled) {
          cleanup()
          reject(new Error('relay connection closed unexpectedly'))
        }
      })

      ws.addEventListener('open', () => {
        // join the human's room
        ws.send(JSON.stringify({ type: 'join', room: humanPubkeyHex }))
      })

      ws.addEventListener('message', (event) => {
        if (settled) return

        let msg: any
        try {
          msg = JSON.parse(event.data as string)
        } catch {
          return // ignore non-JSON
        }

        if (msg.type === 'joined') {
          this.emit('connected', { room: humanPubkeyHex })
          // room joined — send the encrypted tx request
          const plaintext = JSON.stringify(txRequest)
          const ciphertext = encryptMessage(plaintext, humanPubkey, secretKey)
          const envelope: AgentEnvelope = {
            sender_pubkey: agentPubkeyHex,
            ciphertext,
            signing_pubkey: signingPubkeyHex,
          }
          ws.send(JSON.stringify({
            type: 'message',
            room: humanPubkeyHex,
            payload: JSON.stringify(envelope),
          }))
          this.emit('request_sent', { request_id: requestId })
          return
        }

        if (msg.type === 'message') {
          // try to decrypt as TxResponse
          try {
            const envelope: AgentEnvelope = JSON.parse(msg.payload)
            const plaintext = decryptMessage(
              envelope.ciphertext,
              fromHex(envelope.sender_pubkey),
              secretKey,
            )
            if (!plaintext) return // not for us or decryption failed

            const response: TxResponse = JSON.parse(plaintext)
            if (response.request_id !== requestId) return // not our response

            this.emit('response', {
              request_id: response.request_id,
              status: response.status,
              tx_hash: response.tx_hash,
            })

            cleanup()

            if (response.status === 'approved' && response.tx_hash) {
              resolve(response.tx_hash)
            } else if (response.status === 'rejected') {
              reject(new Error(`request ${requestId} rejected by human`))
            } else if (response.error) {
              reject(new Error(`request ${requestId} failed: ${response.error}`))
            } else {
              reject(new Error(`request ${requestId}: unexpected response status "${response.status}"`))
            }
          } catch {
            // ignore messages that aren't valid envelopes
          }
        }

        if (msg.type === 'error') {
          cleanup()
          this.emit('error', { message: `relay error: ${msg.message}` })
          reject(new Error(`relay error: ${msg.message}`))
        }
      })
    })
  }
}
