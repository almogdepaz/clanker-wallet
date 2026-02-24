# clanker-wallet

Human-approved blockchain transactions for AI agents. Agent proposes a tx, human reviews and signs it from the [web app](https://clanker-wallet.xyz). All communication is end-to-end encrypted.

## Install

```bash
npm install -g clanker-wallet
```

Or run without installing:
```bash
npx clanker-wallet
bunx clanker-wallet
```

## Quick Start

```bash
# 1. Human goes to https://clanker-wallet.xyz, connects wallet, copies pairing JSON
# 2. Pair (one-time)
clanker-wallet pair '{"version":1,"pubkey":"ab12...","relay":"wss://...","wallet":"0x..."}'

# 3. Send a transaction (blocks until human approves or rejects)
clanker-wallet tx --chain 1 --to 0xRecipient --value 1000000000000000000 --reason "swap ETH for USDC"

# 4. Check status anytime
clanker-wallet status
```

## Commands

### `pair`

Pair with a human's web app. Run once — identity and pairing are saved to `~/.clanker-wallet/`.

```bash
clanker-wallet pair '<pairing JSON from web app>'
# → {"agent_id":"agent_abc123","status":"paired","wallet":"0x...","relay":"wss://..."}
```

### `tx`

Send a transaction request. Blocks until the human approves or rejects.

```bash
clanker-wallet tx \
  --chain 1 \
  --to 0xRecipient \
  --value 1000000000000000000 \
  --data 0x \
  --reason "swap ETH for USDC" \
  --urgency medium \
  --timeout 120000
# approved → {"tx_hash":"0x...","status":"approved"}
# rejected → {"status":"rejected","error":"..."} (exit code 1)
# timeout  → {"status":"timeout","error":"..."}  (exit code 2)
```

**Flags:**
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--chain <id>` | yes | — | Chain ID (1=Ethereum, 137=Polygon, 8453=Base) |
| `--to <address>` | yes | — | Recipient address |
| `--value <wei>` | no | `0` | Value in wei (1 ETH = `1000000000000000000`) |
| `--data <hex>` | no | `0x` | Calldata hex |
| `--reason <text>` | no | — | Shown to human |
| `--urgency <level>` | no | — | `low`, `medium`, or `high` |
| `--expected-outcome <text>` | no | — | What will happen |
| `--timeout <ms>` | no | `3600000` | How long to wait |

### `status`

Check current pairing status.

```bash
clanker-wallet status
# → {"agent_id":"agent_abc123","paired":true,"wallet":"0x...","relay":"wss://..."}
```

### `whoami`

Show agent identity.

```bash
clanker-wallet whoami
# → {"agent_id":"agent_abc123","public_key":"ab12cd..."}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Rejected by human |
| 2 | Timeout |
| 3 | Connection/relay error |
| 4 | Not paired |
| 5 | Invalid arguments |

## State

Identity and pairing are persisted in `~/.clanker-wallet/`:

```
~/.clanker-wallet/
  identity.json    # agent keypair (auto-generated on first use)
  pairing.json     # human's public key + relay URL
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

---

## Library Usage (Advanced)

The CLI wraps a TypeScript library. For programmatic use:

```bash
npm install clanker-wallet
```

```typescript
import { ClankerWallet } from 'clanker-wallet'

const wallet = new ClankerWallet({ agentName: 'my-bot' })
wallet.pair(pairingJson)

const txHash = await wallet.requestTx({
  chain_id: 1,
  transaction: { to: '0x...', value: '1000000000000000000', data: '0x' },
  context: { reason: 'Buy tokens', urgency: 'medium' },
})
```

See full API: [`src/`](./src/)

## Python SDK

```bash
pip install clanker-wallet
```

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
2. Agent runs `clanker-wallet pair` — establishes E2E encrypted channel
3. Agent runs `clanker-wallet tx` — encrypts tx with nacl.box, sends via WebSocket relay
4. Human reviews tx details, simulation, risk flags in the web app
5. Human approves → wallet signs + broadcasts → agent gets the tx hash

All messages are encrypted end-to-end. The relay server never sees plaintext.

## License

MIT
