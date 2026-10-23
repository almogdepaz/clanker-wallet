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
# 1. Human goes to https://clanker-wallet.xyz, connects wallet, clicks "copy prompt for agent",
#    pastes the prompt to you. The prompt contains a JSON pairing code.
# 2. Pair (one-time) — extract the JSON from the prompt
clanker-wallet pair '{"version":1,"pubkey":"ab12...","relay":"wss://...","wallet":"0x..."}'

# 3. Send a transaction (blocks until human approves or rejects; 1 h by default)
#    0.001 ETH on Base Sepolia (84532) to the burn address. --value is in wei.
clanker-wallet tx --chain 84532 --to 0x000000000000000000000000000000000000dEaD --value 1000000000000000 --reason "send 0.001 ETH on base sepolia"

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

Send a transaction request. Blocks until the human approves or rejects, for up to 1 hour by default; `--timeout <ms>` changes that.

```bash
clanker-wallet tx \
  --chain 84532 \
  --to 0x000000000000000000000000000000000000dEaD \
  --value 1000000000000000 \
  --data 0x \
  --reason "send 0.001 ETH on base sepolia" \
  --urgency medium \
  --timeout 600000
# approved → {"tx_hash":"0x...","status":"approved"}
# rejected → {"status":"rejected","error":"..."} (exit code 1)
# timeout  → {"status":"timeout","error":"..."}  (exit code 2)
# bad flag → "invalid --to: ..." on stderr, nothing sent (exit code 5)
```

`--to` must be `0x` + 40 hex characters (mixed case must pass the EIP-55 checksum), `--value` a whole number of wei, `--data` even-length hex. See [SKILL.md](./SKILL.md) for ERC-20 examples.

**Flags:**
| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--chain <id>` | yes | — | Chain ID (1=Ethereum, 8453=Base, 84532=Base Sepolia) |
| `--to <address>` | yes | — | Recipient address |
| `--value <wei>` | no | `0` | Value in wei (1 ETH = `1000000000000000000`) |
| `--data <hex>` | no | `0x` | Calldata hex |
| `--reason <text>` | no | — | Shown to human |
| `--urgency <level>` | no | — | `low`, `medium`, or `high` |
| `--expected-outcome <text>` | no | — | What will happen |
| `--timeout <ms>` | no | `3600000` (1 h) | How long `tx` blocks waiting for the human |

### `status`

Check current pairing status.

```bash
clanker-wallet status
# → {"agent_id":"agent_abc123","paired":true,"wallet":"0x...","relay":"wss://..."}
```

### `whoami`

Show agent identity. `fingerprint` (first 16 hex chars of the public key) is what the web app shows for this agent; the human compares it before trusting the agent.

```bash
clanker-wallet whoami
# → {"agent_id":"agent_abc123","public_key":"ab12cd34ef567890...","fingerprint":"ab12 cd34 ef56 7890"}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Rejected by human |
| 2 | Timeout |
| 3 | Connection/relay error |
| 4 | Not paired |
| 5 | Invalid arguments (bad or missing flag; nothing sent) |

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
| Base Sepolia (testnet) | 84532 |

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

// 0.001 ETH on Base Sepolia; value is wei (string or bigint)
const txHash = await wallet.requestTx({
  chain_id: 84532,
  transaction: { to: '0x000000000000000000000000000000000000dEaD', value: '1000000000000000', data: '0x' },
  context: { reason: 'send 0.001 ETH on base sepolia', urgency: 'medium' },
})
```

`requestTx` throws `InvalidTxError` (with `field` and `reason`) before anything is sent if `chain_id`, `to`, `value` or `data` is malformed.

See full API: [`src/`](./src/)

## Python SDK

Requires Python 3.10+.

```bash
pip install clanker-wallet
```

```python
from clanker_wallet import ClankerWallet, Transaction, RequestTxOptions, TxContext

agent = ClankerWallet()
agent.pair(pairing_json)

tx_hash = await agent.request_tx(RequestTxOptions(
    chain_id=84532,  # base sepolia
    transaction=Transaction(to="0x000000000000000000000000000000000000dEaD", value="1000000000000000", data="0x"),
    context=TxContext(reason="send 0.001 ETH on base sepolia"),
))
```

## How It Works

1. Human opens [clanker-wallet.xyz](https://clanker-wallet.xyz), connects wallet, clicks "copy prompt for agent" — gets a paste-ready prompt that bundles intent, the setup guide URL, and the pairing JSON
2. Human pastes the prompt to their AI agent. Agent extracts the JSON and runs `clanker-wallet pair` — establishes E2E encrypted channel
3. Agent runs `clanker-wallet tx` — encrypts tx with nacl.box, sends via WebSocket relay
4. Human reviews tx details, simulation, risk flags in the web app. A new agent shows up as unverified with its fingerprint; auto-approve rules only apply after the human trusts it. Contract rules (address + methods) don't limit token amounts or recipients
5. Human approves → wallet signs + broadcasts → agent gets the tx hash

Request and response payloads are encrypted end-to-end; the relay only forwards them. Exception: when paired in managed mode, the agent also sends the transaction fields (from, to, value, data, chainId) to the relay for simulation.

## License

MIT
