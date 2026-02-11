---
name: clanker-wallet
description: "Send blockchain transactions through a human-approved wallet. You propose tx, human reviews and signs. No private keys needed."
homepage: https://clanker-wallet.vercel.app
metadata: {"clawdbot":{"requires":{"packages":["clanker-wallet"]}}}
---

# Clanker Wallet — Human-Approved Transactions

You are an AI agent that needs to send blockchain transactions. You do NOT have a private key. Instead, you propose transactions and a human approves them from their own wallet.

## Setup

```bash
npm install clanker-wallet
```

## Pairing (one-time)

Before you can send transactions, you must pair with the human. Ask them:

> "I need to send blockchain transactions on your behalf. Please go to https://clanker-wallet.vercel.app, connect your wallet, and give me the pairing JSON."

The human will give you a JSON string like:
```json
{"version":1,"pubkey":"ab12cd...","relay":"wss://clanker-relay.fly.dev/ws","wallet":"0x..."}
```

Save this pairing JSON — you'll need it every session.

```typescript
import { ClankerWallet } from 'clanker-wallet'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// Restore or create agent identity
const secretKey = existsSync('.agent-key')
  ? new Uint8Array(readFileSync('.agent-key'))
  : undefined

const wallet = new ClankerWallet({ agentName: 'my-agent', secretKey })

// Save identity for next session
if (!secretKey) writeFileSync('.agent-key', wallet.secretKey)

// Pair with human
wallet.pair(pairingJson)
```

## Sending a Transaction

`requestTx()` sends the request to the human and **blocks until they approve or reject**. It returns the transaction hash on approval, or throws on rejection/timeout.

```typescript
const txHash = await wallet.requestTx({
  chain_id: 1,            // 1=Ethereum, 137=Polygon, 8453=Base, 42161=Arbitrum
  transaction: {
    to: '0x...',           // recipient address
    value: '0',            // amount in WEI (not ETH!) — '0' for contract calls
    data: '0x',            // calldata hex — '0x' for simple transfers
  },
  context: {
    reason: 'Why this tx is needed',    // shown to human
    urgency: 'low',                     // low | medium | high
    expected_outcome: 'What will happen',
  },
  timeout_ms: 120_000,    // how long to wait (default: 1 hour)
})
```

## Critical Details

- **value is in WEI, not ETH.** 1 ETH = `'1000000000000000000'`. Use string, not number.
- **data is hex-encoded calldata.** Use `'0x'` for simple ETH transfers. For contract calls, encode the function call (e.g. with viem's `encodeFunctionData`).
- **requestTx() blocks.** The human must be online to approve. Set a reasonable `timeout_ms`.
- **On rejection, it throws.** Wrap in try/catch:

```typescript
try {
  const txHash = await wallet.requestTx({ ... })
  console.log('approved:', txHash)
} catch (err) {
  console.log('rejected or timed out:', err.message)
}
```

## Common Chain IDs

| Chain | ID |
|-------|----|
| Ethereum | 1 |
| Polygon | 137 |
| Arbitrum | 42161 |
| Base | 8453 |
| Optimism | 10 |
| Sepolia (testnet) | 11155111 |

## Common Patterns

### Simple ETH transfer
```typescript
await wallet.requestTx({
  chain_id: 1,
  transaction: {
    to: '0xRecipientAddress',
    value: '1000000000000000',  // 0.001 ETH
    data: '0x',
  },
  context: { reason: 'Send 0.001 ETH to recipient' },
})
```

### ERC-20 token transfer
```typescript
// transfer(address to, uint256 amount)
// selector: 0xa9059cbb
const to = '0xRecipient'.slice(2).padStart(64, '0')
const amount = BigInt('1000000').toString(16).padStart(64, '0')  // 1 USDC (6 decimals)
const data = '0xa9059cbb' + to + amount

await wallet.requestTx({
  chain_id: 1,
  transaction: {
    to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',  // USDC contract
    value: '0',
    data,
  },
  context: { reason: 'Transfer 1 USDC' },
})
```

### ERC-20 approval
```typescript
// approve(address spender, uint256 amount)
// selector: 0x095ea7b3
const spender = '0xSpenderAddress'.slice(2).padStart(64, '0')
const amount = BigInt('1000000').toString(16).padStart(64, '0')
const data = '0x095ea7b3' + spender + amount

await wallet.requestTx({
  chain_id: 1,
  transaction: {
    to: '0xTokenContractAddress',
    value: '0',
    data,
  },
  context: { reason: 'Approve 1 USDC spend for DeFi protocol' },
})
```

## Events (optional)

Monitor connection lifecycle:

```typescript
wallet.on('connected', ({ room }) => console.log('connected to relay'))
wallet.on('request_sent', ({ request_id }) => console.log('tx sent, waiting for human'))
wallet.on('response', ({ status, tx_hash }) => console.log('human responded:', status))
wallet.on('error', ({ message }) => console.error('error:', message))
wallet.on('disconnected', () => console.log('relay disconnected'))
```

## Troubleshooting

- **"not paired"** — call `wallet.pair(json)` before `requestTx()`
- **timeout** — human didn't respond in time, increase `timeout_ms` or ask them to check the web app
- **"rejected by human"** — human clicked reject. Explain why the tx is needed and try again if appropriate.
- **connection error** — relay may be down, try again in a few seconds
