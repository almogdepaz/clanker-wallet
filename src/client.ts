import { decryptMessage, encryptMessage, fromHex, generateKeypair, keypairFromSecret, signMessage, signingKeypairFromSeed, toHex } from './crypto.js'
import { TypedEmitter } from './events.js'
import type { AgentEnvelope, PairingData, RequestTransferOptions, RequestTxOptions, TransferRequest, TxRequest, TxResponse } from './types.js'
import { InvalidTxError, validateTransfer, validateTx } from './validate.js'

const DEFAULT_TIMEOUT_MS = 3_600_000 // 1 hour

const UNREACHABLE_HINT = 'if you run in a sandbox or behind a firewall, allow this host; otherwise the relay may be down or rate limiting, retry in a few seconds'

/** node's WebSocket ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set at startup, and sandboxes (claude code) only let traffic out through that proxy */
function proxyHint(): string {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  if (!env || env.NODE_USE_ENV_PROXY) return ''
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
    ? '; HTTPS_PROXY is set but node ignores it, rerun with NODE_USE_ENV_PROXY=1 (node 24+)'
    : ''
}

export interface ClankerWalletOptions {
  /** agent display name (informational) */
  agentName?: string
  /** 32-byte secret key to restore identity. if omitted, generates a new keypair. */
  secretKey?: Uint8Array
}

/** pairing state set by pair(), consumed by requestTx() */
interface PairingState {
  humanPubkey: Uint8Array
  humanPubkeyHex: string
  relayUrl: string
  humanWallet: string | null
  mode: 'encrypted' | 'managed'
  /** absent for an evm pairing */
  chainFamily: string | null
  chainNetwork: string | null
}

export class ClankerWallet extends TypedEmitter {
  readonly publicKey: Uint8Array
  readonly secretKey: Uint8Array
  readonly agentId: string
  /** Ed25519 public key for signing TxRequests */
  readonly signingPublicKey: Uint8Array
  private readonly signingSecretKey: Uint8Array
  private readonly agentPubkeyHex: string
  private readonly signingPubkeyHex: string

  private pairing: PairingState | null = null

  constructor(options: ClankerWalletOptions = {}) {
    super()
    const kp = options.secretKey
      ? keypairFromSecret(options.secretKey)
      : generateKeypair()

    this.publicKey = kp.publicKey
    this.secretKey = kp.secretKey
    this.agentId = `agent_${toHex(kp.publicKey).slice(0, 12)}`
    this.agentPubkeyHex = toHex(kp.publicKey)

    const signingKp = signingKeypairFromSeed(kp.secretKey)
    this.signingPublicKey = signingKp.publicKey
    this.signingSecretKey = signingKp.secretKey
    this.signingPubkeyHex = toHex(signingKp.publicKey)
  }

  /** whether this agent has been paired with a human */
  get paired(): boolean {
    return this.pairing !== null
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

    this.pairing = {
      humanPubkey: fromHex(data.pubkey),
      humanPubkeyHex: data.pubkey,
      relayUrl: data.relay,
      humanWallet: data.wallet || null,
      mode: data.mode || 'encrypted',
      chainFamily: data.chain_family || null,
      chainNetwork: data.chain_network || null,
    }

    this.emit('paired', { relay: data.relay, wallet: data.wallet || '' })

    return data
  }

  /**
   * send a transaction request to the paired human and wait for their response.
   * resolves with tx hash on approval.
   * throws on rejection, timeout, or connection error.
   */
  async requestTx(options: RequestTxOptions): Promise<string> {
    if (!this.pairing) {
      throw new Error('not paired — call pair() first')
    }

    // a bitcoin or chia pairing takes transfers only: its wallet can't sign an evm tx
    const { chainFamily } = this.pairing
    if (chainFamily && chainFamily !== 'evm') {
      throw new InvalidTxError('chain_family', `this pairing is for ${chainFamily}: use requestTransfer for bitcoin or chia`)
    }

    // reject malformed requests before anything reaches the relay
    const { chain_id, transaction } = validateTx(options.chain_id, options.transaction)

    const { humanWallet, mode } = this.pairing

    const txRequest: TxRequest = {
      request_id: newRequestId(),
      agent_id: this.agentId,
      timestamp: new Date().toISOString(),
      chain_id,
      transaction,
      context: options.context,
      signature: '', // set below after signing
    }

    txRequest.signature = signMessage(JSON.stringify(txRequest), this.signingSecretKey)

    // managed mode: relay gets plaintext tx params so it can simulate
    const simulate = mode === 'managed'
      ? { from: humanWallet || '', to: transaction.to, value: transaction.value, data: transaction.data, chainId: chain_id }
      : undefined

    return this.send(txRequest, options, simulate)
  }

  /**
   * send a bitcoin / chia transfer to the paired human and wait for their response.
   * the family comes from the pairing; the human's wallet builds, signs and broadcasts
   * the send. resolves with the txid on approval.
   * throws InvalidTxError (before anything is sent), or on rejection, timeout, or connection error.
   */
  async requestTransfer(options: RequestTransferOptions): Promise<string> {
    if (!this.pairing) {
      throw new Error('not paired — call pair() first')
    }

    const { chainFamily, chainNetwork } = this.pairing
    // reject malformed requests before anything reaches the relay
    const { chain_family, chain_network, transfer } = validateTransfer(chainFamily, options.chain_network, options.transfer)
    if (chainNetwork && chainNetwork !== chain_network) {
      throw new InvalidTxError('chain_network', `this pairing is for ${chain_family} ${chainNetwork}, got "${chain_network}"`)
    }

    const request: TransferRequest = {
      request_id: newRequestId(),
      agent_id: this.agentId,
      timestamp: new Date().toISOString(),
      chain_family,
      chain_network,
      transfer,
      context: options.context,
      signature: '', // set below after signing
    }

    request.signature = signMessage(JSON.stringify(request), this.signingSecretKey)

    // the relay simulator is evm-only: no simulate object for transfers, even on a managed pairing
    return this.send(request, options)
  }

  /** encrypt a signed request to the paired human, send it through the relay, and wait for the answer */
  private send(
    request: TxRequest | TransferRequest,
    options: Pick<RequestTxOptions, 'timeout_ms' | 'join_timeout_ms' | 'signal'>,
    simulate?: Record<string, unknown>,
  ): Promise<string> {
    const { humanPubkey, humanPubkeyHex, relayUrl } = this.pairing!
    const requestId = request.request_id
    const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const { join_timeout_ms: joinTimeoutMs, signal } = options

    return new Promise<string>((resolve, reject) => {
      let ws: WebSocket
      let timer: ReturnType<typeof setTimeout>
      let joinTimer: ReturnType<typeof setTimeout> | undefined
      let settled = false

      const onAbort = (): void => {
        if (!settled) fail(`request ${requestId} cancelled`)
      }

      const cleanup = (): void => {
        settled = true
        clearTimeout(timer)
        clearTimeout(joinTimer)
        signal?.removeEventListener('abort', onAbort)
        if (ws && ws.readyState <= WebSocket.OPEN) {
          ws.close()
        }
      }

      const fail = (message: string): void => {
        cleanup()
        this.emit('error', { message })
        reject(new Error(message))
      }

      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort)

      timer = setTimeout(() => {
        if (!settled) {
          fail(`request ${requestId} timed out after ${timeoutMs}ms`)
        }
      }, timeoutMs)

      this.emit('connecting', { relay: relayUrl })

      // the request goes out only once joined, so failing before then guarantees nothing was sent
      if (joinTimeoutMs !== undefined) {
        joinTimer = setTimeout(() => {
          if (!settled) fail(`relay ${relayUrl} did not answer join within ${joinTimeoutMs}ms; request ${requestId} was not sent`)
        }, joinTimeoutMs)
      }

      try {
        ws = new WebSocket(relayUrl)
      } catch (err) {
        fail(`failed to connect to relay: ${err}`)
        return
      }

      ws.addEventListener('error', () => {
        // node's WebSocket error event carries no cause, so name the url: a sandbox or firewall blocking it looks the same as an outage
        if (!settled) fail(`relay connection error: could not reach ${relayUrl} (${UNREACHABLE_HINT}${proxyHint()})`)
      })

      ws.addEventListener('close', () => {
        this.emit('disconnected', {})
        if (!settled) {
          cleanup()
          reject(new Error('relay connection closed unexpectedly'))
        }
      })

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join', room: humanPubkeyHex }))
      })

      ws.addEventListener('message', (event) => {
        if (settled) return

        let msg: { type: string; payload?: string; message?: string }
        try {
          msg = JSON.parse(event.data as string)
        } catch {
          return
        }

        if (msg.type === 'joined') {
          clearTimeout(joinTimer)
          this.emit('connected', { room: humanPubkeyHex })

          const ciphertext = encryptMessage(JSON.stringify(request), humanPubkey, this.secretKey)
          const envelope: AgentEnvelope = {
            sender_pubkey: this.agentPubkeyHex,
            ciphertext,
            signing_pubkey: this.signingPubkeyHex,
          }
          const wsMsg: Record<string, unknown> = {
            type: 'message',
            room: humanPubkeyHex,
            payload: JSON.stringify(envelope),
          }
          if (simulate) wsMsg.simulate = simulate
          ws.send(JSON.stringify(wsMsg))
          this.emit('request_sent', { request_id: requestId })
          return
        }

        if (msg.type === 'message') {
          try {
            const envelope: AgentEnvelope = JSON.parse(msg.payload!)
            // only the paired human may answer
            if (envelope.sender_pubkey?.toLowerCase() !== humanPubkeyHex.toLowerCase()) return
            const plaintext = decryptMessage(envelope.ciphertext, humanPubkey, this.secretKey)
            if (!plaintext) return

            const response: TxResponse = JSON.parse(plaintext)
            if (response.request_id !== requestId) return

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
          return
        }

        if (msg.type === 'error') {
          fail(`relay error: ${msg.message}`)
        }
      })
    })
  }
}

function newRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
