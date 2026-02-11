# clanker-wallet

TypeScript SDK for AI agents to request human-approved Ethereum transactions over an E2E encrypted relay.

## Install

```bash
npm install clanker-wallet
```

## Quickstart

```typescript
import { ClankerWallet } from 'clanker-wallet'

const wallet = new ClankerWallet({ agentName: 'my-trading-bot' })

// Pair with human's web app (scan QR code to get pairing JSON)
wallet.pair(pairingJson)

// Request a transaction — blocks until human approves or rejects
const txHash = await wallet.requestTx({
  chain_id: 1,
  transaction: { to: '0x...', value: '1000000000000000000', data: '0x' },
  context: { reason: 'Buy tokens', urgency: 'medium' },
})

console.log('tx hash:', txHash)
```

## How It Works

- **E2E encrypted** — agent and human derive an X25519 shared secret. The relay only sees ciphertext.
- **Relay transport** — lightweight WebSocket relay forwards encrypted messages between agent and human. No private keys touch the server.
- **Human approval** — the human reviews transaction details in the Clanker Wallet web app and signs with their own wallet (MetaMask, WalletConnect, etc).

## API

### `new ClankerWallet(options?)`

| Option | Type | Description |
|--------|------|-------------|
| `agentName` | `string` | Display name shown to human (optional) |
| `secretKey` | `Uint8Array` | 32-byte secret key to restore identity. Omit to generate new keypair. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `publicKey` | `Uint8Array` | Agent's X25519 public key |
| `secretKey` | `Uint8Array` | Agent's X25519 secret key (save this to persist identity) |
| `agentId` | `string` | Derived agent identifier (`agent_<pubkey_prefix>`) |
| `paired` | `boolean` | Whether `pair()` has been called |

### `wallet.pair(qrData: string): PairingData`

Parse pairing JSON (from the web app's QR code) and store the human's public key and relay URL. Returns the parsed `PairingData`.

### `wallet.requestTx(options): Promise<string>`

Send a transaction request and wait for human response. Resolves with the transaction hash on approval. Throws on rejection, timeout, or connection error.

| Option | Type | Description |
|--------|------|-------------|
| `chain_id` | `number` | Target chain (1 = mainnet, 137 = polygon, etc) |
| `transaction` | `{ to, value, data }` | Transaction parameters (`value` in wei) |
| `context` | `{ reason?, urgency?, expected_outcome? }` | Optional context shown to human |
| `timeout_ms` | `number` | Timeout in ms (default: 1 hour) |

## Persisting Agent Identity

Save `wallet.secretKey` between sessions to keep the same agent identity:

```typescript
import { writeFileSync, readFileSync, existsSync } from 'fs'

// Restore or create
const secretKey = existsSync('.agent-key')
  ? new Uint8Array(readFileSync('.agent-key'))
  : undefined

const wallet = new ClankerWallet({ secretKey })

// Save for next time
if (!secretKey) writeFileSync('.agent-key', wallet.secretKey)
```

## Web App

The human-facing web app is at [clanker-wallet.vercel.app](https://clanker-wallet.vercel.app). Connect a wallet, scan the QR code from your agent, and approve transactions.

## License

MIT
