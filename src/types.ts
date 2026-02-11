/** transaction to send */
export interface Transaction {
  to: string
  value: string
  data: string
}

/** optional context about the transaction */
export interface TxContext {
  reason?: string
  urgency?: string
  expected_outcome?: string
}

/** full tx request sent to the human (matches web app TxRequest) */
export interface TxRequest {
  request_id: string
  agent_id: string
  timestamp: string
  chain_id: number
  transaction: Transaction
  context?: TxContext
  signature: string
}

/** response from the human (decrypted) */
export interface TxResponse {
  request_id: string
  status: 'approved' | 'rejected'
  tx_hash?: string
  error?: string
}

/** wire format sent over relay */
export interface AgentEnvelope {
  sender_pubkey: string
  ciphertext: string
  /** Ed25519 public key (hex) for verifying TxRequest signatures */
  signing_pubkey?: string
}

/** pairing data from QR code */
export interface PairingData {
  version: number
  pubkey: string
  relay: string
  wallet: string
}

/** options for requestTx */
export interface RequestTxOptions {
  chain_id: number
  transaction: Transaction
  context?: TxContext
  /** timeout in ms (default: 3_600_000 = 1hr) */
  timeout_ms?: number
}
