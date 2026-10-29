# clanker-wallet

Human-approved blockchain transactions for AI agents. Agent proposes a tx, human reviews and signs it from the [web app](https://clanker-wallet.xyz). All communication is end-to-end encrypted. EVM chains take raw transactions; bitcoin and chia take transfers (network, recipient, amount) that the human's wallet builds.

## Install

```bash
npm install -g clanker-wallet
```

Or run without installing:
```bash
npx clanker-wallet
bunx clanker-wallet
```

Running in a sandbox (e.g. Claude Code)? Allow a WebSocket to the relay, `wss://relay.clanker-wallet.xyz/ws` (the `relay` URL in the pairing JSON), or `tx` fails with exit code 3. If the sandbox only lets traffic out through `HTTPS_PROXY`, run the CLI as `NODE_USE_ENV_PROXY=1 clanker-wallet ...` (Node 24+); Node ignores the proxy otherwise. `pair` writes `~/.clanker-wallet/` and the other commands write there too, so allow writes (see [State](#state)).

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

Pair with a human's web app. Run once per chain family — `pair` writes identity and pairing to `~/.clanker-wallet/`. The web app's bitcoin and chia tabs give pairing JSON with `"chain_family":"bitcoin"` / `"chain_family":"chia"`; each family is kept in its own file, so pairing one never replaces another.

If the pairing JSON contains `"mode":"managed"`, the relay simulates each transaction for the human's review screen, so `tx` also sends the plain transaction fields to it. Otherwise the relay only sees ciphertext. Pair with the JSON as given.

```bash
clanker-wallet pair '<pairing JSON from web app>'
# → {"agent_id":"agent_abc123","status":"paired","wallet":"0x...","relay":"wss://..."}
```

### `tx`

Send a transaction request. Blocks until the human approves or rejects, for up to 1 hour by default; `--timeout <ms>` changes that. If your shell tool kills long commands, run `tx` in the background and read its output when it exits.

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

### `send`

Send bitcoin or chia. The human's wallet builds, signs and broadcasts the transaction; you give the network, recipient and amount. Needs a pairing from the web app's bitcoin or chia tab. Same blocking, `--reason`/`--urgency`/`--expected-outcome`/`--timeout`, output and exit codes as `tx`; exit code 4 means that chain family isn't paired.

```bash
clanker-wallet send --btc testnet --to tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx --sats 1000 --reason "send 1000 sats on bitcoin testnet"
clanker-wallet send --xch testnet11 --to txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg --mojos 1000 --fee-mojos 0 --reason "send 1000 mojos on chia testnet11"
# approved → {"tx_hash":"<bitcoin txid or chia transaction id>","status":"approved"}
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--btc <network>` | one of `--btc`/`--xch` | — | `mainnet`, `testnet` or `signet` |
| `--xch <network>` | one of `--btc`/`--xch` | — | `mainnet` or `testnet11` |
| `--to <address>` | yes | — | On that network: segwit `bc1...`/`tb1...` (no legacy `1...`/`3...`), or `xch1...`/`txch1...` |
| `--sats <n>` | with `--btc` | — | Whole sats (1 BTC = `100000000`); the wallet sets the fee |
| `--mojos <n>` | with `--xch` | — | Whole mojos (1 XCH = `1000000000000`) |
| `--fee-mojos <n>` | no (chia only) | `0` | Chia fee, shown to the human |

### `status`

Check current pairing status. `wallet` and `relay` are the evm pairing's; `pairings` lists every paired chain family.

```bash
clanker-wallet status
# → {"agent_id":"agent_abc123","paired":true,"wallet":"0x...","relay":"wss://...",
#    "pairings":{"evm":{"wallet":"0x...","relay":"wss://...","mode":null,"chain_network":null}}}
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
| 4 | Not paired (`send`: not paired for that chain family) |
| 5 | Invalid arguments (bad or missing flag; nothing sent) |

## State

Identity and pairing are persisted in `~/.clanker-wallet/`:

```
~/.clanker-wallet/
  identity.json        # agent keypair (auto-generated on first use)
  pairings/evm.json    # per chain family: human's public key + relay URL
  pairings/bitcoin.json
  pairings/chia.json
  pairing.json         # written by 0.4.x; still read as the evm pairing, never changed
```

`~/.clanker-wallet/pairings/<family>.json` takes precedence over a 0.4.x `pairing.json`, which is never moved, rewritten or deleted.

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

## MCP (assistants)

`clanker-wallet mcp` runs an MCP server over stdio, so an assistant (Claude Desktop, Claude Code, Cursor, or another MCP host that runs local commands) can ask for transactions as tool calls. The human approves every request on their own device; the server holds no wallet keys. It uses the CLI's identity and pairings in `~/.clanker-wallet/`, so pair first (`clanker-wallet pair '<JSON>'`, once per chain family). In a sandbox the server needs the same relay access and `~/.clanker-wallet/` writes as the CLI.

Claude Code:

```bash
claude mcp add clanker-wallet -- npx -y clanker-wallet mcp
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`), and any other MCP host that runs local stdio servers (command `npx`, args `-y clanker-wallet mcp`):

```json
{
  "mcpServers": {
    "clanker-wallet": { "command": "npx", "args": ["-y", "clanker-wallet", "mcp"] }
  }
}
```

| Tool | Arguments | Returns |
|------|-----------|---------|
| `request_evm_tx` | `chain_id`, `to`, `value` (wei, integer string), `data` (default `0x`), `reason`, optional `urgency` / `expected_outcome` | `{"request_id":"req_...","status":"pending","expires_at":"..."}` |
| `request_transfer` | `family` (`bitcoin`), `network` (`mainnet`, `testnet`, `signet`), `to`, `amount` (sats, integer string), `reason`, optional `urgency` / `expected_outcome` | as above |
| `get_request` | `request_id`, optional `wait_seconds` (at most 50) | `status`: `pending`, `approved` (with `tx_hash`), `rejected`, `failed` (with `error`), `unknown` (with `error`) or `expired` |
| `list_pairings` | none | `agent_id`, `fingerprint`, and the paired families (`evm`, `bitcoin`) with network, wallet and mode |

Requests are asynchronous: a request tool returns once the relay has the request, then the assistant calls `get_request` (with `wait_seconds` to wait for an answer) until the status is no longer `pending`. Invalid input or a missing pairing is a tool error, and nothing is sent. Pending requests live in the server process: each expires after 1 h, and a restarted server no longer knows them (`get_request` then reports an unknown `request_id`). `unknown` means the request was delivered but the server lost its relay connection: the human may still approve it, so ask them before sending it again. Chia is not offered over MCP yet.

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

With a bitcoin or chia pairing, use `requestTransfer`; the family comes from the pairing:

```typescript
// 1000 mojos on chia testnet11; amount and fee are integer strings or bigints
const txId = await wallet.requestTransfer({
  chain_network: 'testnet11',
  transfer: { asset: 'xch', to: 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg', amount: '1000', fee: '0' },
  context: { reason: 'send 1000 mojos on chia testnet11' },
})
```

It throws `InvalidTxError` before sending for an evm pairing, an unknown network, a recipient from another network, a non-integer amount, or a bitcoin `fee` (the wallet sets bitcoin fees). Chia `fee` defaults to `"0"`.

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

# with a bitcoin pairing: 1000 sats on bitcoin testnet
from clanker_wallet import RequestTransferOptions, Transfer

txid = await agent.request_transfer(RequestTransferOptions(
    chain_network="testnet",
    transfer=Transfer(asset="btc", to="tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", amount=1000),
))
```

## How It Works

1. Human opens [clanker-wallet.xyz](https://clanker-wallet.xyz), connects wallet, clicks "copy prompt for agent" — gets a paste-ready prompt that bundles intent, the setup guide URL, and the pairing JSON
2. Human pastes the prompt to their AI agent. Agent extracts the JSON and runs `clanker-wallet pair` — establishes E2E encrypted channel
3. Agent runs `clanker-wallet tx` (or `send` for bitcoin/chia) — encrypts the request with nacl.box, sends via WebSocket relay
4. Human reviews tx details, simulation, risk flags in the web app. A new agent shows up as unverified with its fingerprint; auto-approve rules only apply after the human trusts it. Trust applies on every chain family; each chain family has its own policy (rules and remote URL), edited while that chain is selected. Value and daily limits are wei for evm and sats for bitcoin (the sent amount; the wallet's fee isn't counted); a send on another family never matches a rule that sets one, and chia has none. On bitcoin the wallet still confirms each auto-approved send. Contract rules (address + methods) don't limit token amounts or recipients
5. Human approves → wallet signs + broadcasts → agent gets the tx hash

Request and response payloads are encrypted end-to-end; the relay only forwards them. Exception: when paired in managed mode, the agent also sends the transaction fields (from, to, value, data, chainId) to the relay for simulation.

## License

MIT
