/** transaction to send */
export interface Transaction {
  to: string
  value: string
  data: string
}

/** transaction as passed to requestTx: value in wei, data defaults to "0x" */
export interface TxInput {
  to: string
  value: string | bigint
  data?: string
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
  /** "encrypted" (default): relay sees only ciphertext. "managed": relay also receives tx params for simulation. */
  mode?: 'encrypted' | 'managed'
  /** "bitcoin" or "chia" for a non-evm wallet; absent for evm */
  chain_family?: string
  /** the wallet's network, when the pairing names one */
  chain_network?: string
}

/** options for requestTx */
export interface RequestTxOptions {
  chain_id: number
  /** checked before sending; an invalid field throws InvalidTxError */
  transaction: TxInput
  context?: TxContext
  /** timeout in ms (default: 3_600_000 = 1hr) */
  timeout_ms?: number
  /** fail when the relay hasn't confirmed joining the room this long after connecting (default: only timeout_ms applies); nothing was sent then */
  join_timeout_ms?: number
  /** aborting before the relay confirms the join fails the request with nothing sent; after that it only stops waiting */
  signal?: AbortSignal
}

/** wallet families a transfer can go to */
export type TransferFamily = 'bitcoin' | 'chia'

/** an intent-level send: the human's wallet builds and signs it */
export interface Transfer {
  asset: 'btc' | 'xch'
  /** bech32 / bech32m address on the request's network */
  to: string
  /** integer string: sats for btc, mojos for xch */
  amount: string
  /** chia only, in mojos (defaults to "0"); bitcoin wallets set their own fee */
  fee?: string
}

/** transfer as passed to requestTransfer: amounts as decimal strings or bigints */
export interface TransferInput {
  asset: 'btc' | 'xch'
  to: string
  amount: string | bigint
  fee?: string | bigint
}

/** bitcoin / chia request sent to the human: no chain_id, no transaction */
export interface TransferRequest {
  request_id: string
  agent_id: string
  timestamp: string
  chain_family: TransferFamily
  chain_network: string
  transfer: Transfer
  context?: TxContext
  signature: string
}

/** options for requestTransfer; the family comes from the pairing */
export interface RequestTransferOptions {
  /** bitcoin: mainnet | testnet | signet; chia: mainnet | testnet11 */
  chain_network: string
  /** checked before sending; an invalid field throws InvalidTxError */
  transfer: TransferInput
  context?: TxContext
  /** timeout in ms (default: 3_600_000 = 1hr) */
  timeout_ms?: number
  /** fail when the relay hasn't confirmed joining the room this long after connecting (default: only timeout_ms applies); nothing was sent then */
  join_timeout_ms?: number
  /** aborting before the relay confirms the join fails the request with nothing sent; after that it only stops waiting */
  signal?: AbortSignal
}
