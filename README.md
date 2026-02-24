# clanker-wallet

SDK for AI agents to request human-approved blockchain transactions over an E2E encrypted relay.

Agent proposes a transaction, human reviews and signs it from the [web app](https://clanker-wallet.xyz). All communication is end-to-end encrypted — the relay sees nothing.

## Install

```bash
# TypeScript / JavaScript
npm install clanker-wallet
bun add clanker-wallet

# Python
pip install clanker-wallet
```

## CLI

```bash
# generate a new agent keypair
npx clanker-wallet keygen
bunx clanker-wallet keygen
```

## Quickstart (TypeScript)

```typescript
import { ClankerWallet } from 'clanker-wallet'

const wallet = new ClankerWallet({ agentName: 'my-trading-bot' })

// Pair with human's web app (they give you the pairing JSON)
wallet.pair(pairingJson)

// Request a transaction — blocks until human approves or rejects
const txHash = await wallet.requestTx({
  chain_id: 1,
  transaction: { to: '0x...', value: '1000000000000000000', data: '0x' },
  context: { reason: 'Buy tokens', urgency: 'medium' },
})
```

## Quickstart (Python)

```python
from clanker_wallet import ClankerWallet, Transaction, RequestTxOptions, TxContext

agent = ClankerWallet()
agent.pair(pairing_json)

tx_hash = await agent.request_tx(RequestTxOptions(
    chain_id=1,
    transaction=Transaction(to="0x...", value="1000000000000000000", data="0x"),
    context=TxContext(reason="Buy tokens"),
))
```

## How It Works

1. Human opens [clanker-wallet.xyz](https://clanker-wallet.xyz), connects wallet, gets a pairing code
2. Agent calls `pair()` with the pairing code — establishes E2E encrypted channel
3. Agent calls `requestTx()` — encrypts tx with nacl.box, sends via WebSocket relay
4. Human reviews tx details, simulation, risk flags in the web app
5. Human approves → wallet signs + broadcasts → agent gets the tx hash

All messages are encrypted end-to-end. The relay server never sees plaintext.

## API

### TypeScript

See full API docs: [`src/`](./src/)

| Method | Description |
|--------|-------------|
| `new ClankerWallet(options?)` | Create agent. Pass `secretKey` to restore identity. |
| `wallet.pair(json)` | Parse pairing data from web app |
| `wallet.requestTx(options)` | Send tx request, wait for human response |

### Python

See full API docs: [`python/`](./python/)

| Method | Description |
|--------|-------------|
| `ClankerWallet(secret_key=None)` | Create agent. Pass `secret_key` to restore identity. |
| `agent.pair(json)` | Parse pairing data from web app |
| `await agent.request_tx(options)` | Send tx request, wait for human response |

## Persisting Agent Identity

Save the secret key between sessions to keep the same agent identity:

```typescript
// TypeScript
import { writeFileSync, readFileSync, existsSync } from 'fs'
const secretKey = existsSync('.agent-key')
  ? new Uint8Array(readFileSync('.agent-key'))
  : undefined
const wallet = new ClankerWallet({ secretKey })
if (!secretKey) writeFileSync('.agent-key', wallet.secretKey)
```

```python
# Python
secret = agent.secret_key  # save these 32 bytes
agent = ClankerWallet(secret_key=secret)  # restore later
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

## Web App

The human-facing web app is at [clanker-wallet.xyz](https://clanker-wallet.xyz). Connect a wallet, get the pairing code, and approve transactions from your agent.

## License

MIT
