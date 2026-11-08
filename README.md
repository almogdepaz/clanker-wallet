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

A chia approval may have no `tx_hash` (`{"status":"approved"}`): the Sage wallet sends without reporting a transaction id, so check the recipient's balance.

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
| `request_evm_tx` | `chain_id`, `to`, `value` (wei, integer string), `data` (default `0x`), `reason`, optional `urgency` / `expected_outcome` / `from` (the paired wallet to send from, needed when several wallets of the same family are paired) | `{"request_id":"req_...","review_url":"https://clanker-wallet.xyz/?request=req_...","status":"pending","expires_at":"..."}` |
| `request_transfer` | `family` (`bitcoin` or `chia`), `network` (bitcoin: `mainnet`, `testnet`, `signet`; chia: `mainnet`, `testnet11`), `to`, `amount` (sats, integer string) or mojos for chia, `reason`, optional `fee` (chia only: mojos, default `"0"`) / `urgency` / `expected_outcome` / `from` (the paired wallet to send from, needed when several wallets of the same family are paired) | as above |
| `request_token_transfer` | `chain_id`, `to`, `amount` (positive human decimal string), `reason`, optional `token` (listed symbol or contract address; omitted/native symbol = native coin), `from`, `urgency`, `expected_outcome` | `request_id`, `review_url`, pending status and expiry; existing EVM request, no signing here |
| `request_sign_message` | `chain_id`, `message` (UTF-8 text or 0x-prefixed even-length hex bytes), `reason`, optional `from`, `urgency`, `expected_outcome` | `request_id`, `review_url`, pending status and expiry; `get_request` returns `signature` on approval |
| `request_sign_typed_data` | `chain_id`, `typed_data` (parsed EIP-712 object), `reason`, optional `from`, `urgency`, `expected_outcome` | as above; human signs in their wallet |
| `x402_fetch` | `url` (HTTPS), `max_amount` (positive decimal token units), `reason`, optional `method`, `headers`, `body` | free HTTP result, or pending `request_id` and `review_url`; the user signs each payment before one paid retry |
| `get_request` | `request_id`, optional `wait_seconds` (at most 50) | `status`: `pending`, `approved` (with `signature` for signing or `tx_hash` for transactions; a chia send may have none), `rejected`, `failed` (with `error`), `unknown` (with `error`) or `expired` |
| `get_balance` | `family`, `address` (any recipient), EVM `chain_id`, bitcoin/chia `network`, optional EVM `token` (listed symbol or address) | exact `raw_balance`, human `balance`, `asset`, `decimals`; bitcoin also confirmed/mempool deltas; chia recipient puzzle-hash unspent coins only |
| `get_tx_status` | `family` (evm/bitcoin), `tx_hash`, EVM `chain_id` or bitcoin `network` | receipt `status` and `confirmations`; missing EVM receipt is `pending_or_unknown`, missing bitcoin hash is `unknown` |
| `list_pairings` | none | `agent_id`, `fingerprint`, and the paired families (`evm`, `bitcoin`, `chia`) with network, wallet and mode |

### x402 paid HTTP resources

Use `x402_fetch` with an HTTPS `url`, required `max_amount` and `reason`. Optional `method`
is GET (default), POST, PUT, PATCH or DELETE; `headers` is a string map and `body` is a string.
`max_amount` is in decimal token units, e.g. `"0.10"`, not atomic units. Token-list or on-chain
decimals determine the ceiling; server-provided decimals are never trusted and amounts are never rounded.
A non-402 response returns `paid: false` without asking for a signature.

For paid resources, the user signs each payment in their wallet: no auto-pay or auto-approve.
Support is x402 v2 exact EVM eip3009 only (`TransferWithAuthorization`); v1 is not supported.
Permit2, ERC-7710, upto and non-EVM payments are unsupported. A payment above `max_amount` is refused.
The tool returns `request_id`, `review_url` and pending status. Show the URL to the user and use
`get_request` to wait. Each payment has a 10-minute approval window; the authorization also allows the
server's settlement timeout. An expired authorization is never retried.

The card labels resource, description and service claims as server-provided and unverified.
Decoded signed amount, recipient, token and chain remain the source of truth. Conflicting claims require
the existing extra confirmation. Server resource URLs that differ from the fetched URL produce a warning.

After approval there is exactly one paid retry with the original method, headers and body.
`get_request` returns `result` containing HTTP `status`, `content_type`, capped text `body`,
`bytes`, `paid: true` and optional `settlement` (`success`, `transaction`, `network`, `payer`,
`errorReason`). Binary responses omit `body`; long text sets `truncated: true`. A second 402 reports
payment failure without another signature. `settlement_pending` reports the transaction hash as pending;
check it on-chain before deciding what to do next. These are server settlement claims, not independent
confirmation. Repeated polls return the stored result. A hosted connector crash after claiming the retry
reports `outcome unknown; not retried`: do not automatically repeat a possibly paid operation.
A local MCP restart forgets requests, so ask the user before resubmitting.

Requests do not follow redirects: 3xx returns `location`. Each HTTP attempt has a 30-second timeout and
a 1 MiB response limit. Returned text is capped at 8192 UTF-8 bytes; oversized HTTP responses are refused,
not silently read in full. Input allows at most 20 headers / 8192 bytes and a 16384-byte body (no GET body).
Host, content-length, hop-by-hop and payment headers are refused. Never include secrets in the URL or reason.
The hosted connector only fetches public hosts and counts both attempts against its shared 60-per-minute
lookup budget; signature requests also use the usual request budget. Retry credentials are deleted after
completion, rejection, failure or expiry. Headers and bodies are not logged.

### EVM signature requests

Use `request_sign_message` (`personal_sign`) or `request_sign_typed_data` (`eth_signTypedData_v4`).
Show the returned `review_url`: the user reviews and signs in their own wallet. Explain why a signature is
needed: signatures can authorize spending through permits, not just prove identity. `eth_sign` is never
available; there is no bitcoin or chia message signing. These tools require an EVM pairing.

`message` is UTF-8 text or 0x-prefixed even-length hex representing raw bytes, not the literal hex text.
`typed_data` is a parsed `{ domain, types, primaryType, message }` object, not a JSON string.
`types` must include `EIP712Domain` and `primaryType`; `domain.chainId`, when present, must equal
`chain_id`. Supported chains: Ethereum, Base, Arbitrum, Optimism, Polygon and their configured testnets.
The web also requires exact domain type declarations; unsupported/malformed payloads only allow rejection.

Limits: at most 32768 compact JSON UTF-8 bytes for the message or typed-data object, and 40000 bytes
for the complete signed request including context. These leave room for encryption, base64 and the
relay envelope under its 64 KiB limit. Oversize requests fail before relay delivery; nothing is truncated.
Signatures never carry relay simulation data, including in managed mode.

Every signature needs individual manual review: auto-approve rules, batch approval and approval shortcuts
cannot sign. Danger flags or incomplete/failed lookups require a second confirmation; ordinary warnings
do not. Unknown typed-data schemas retain raw fields and warn about unseen authorizations.
Metadata and account-type lookups use trusted chain-scoped sources, never agent-provided labels.
Signing is blocked for an account other than the paired account or a different chain; switch chains and
review again first. The web signs the original payload and verifies recovery to the paired EOA.
Smart-contract wallet signatures (ERC-1271) are not supported.

An approval returns a 65-byte `0x` `signature`, not `tx_hash`; malformed approvals fail.
`get_request` includes it only on approved signature requests. Rejection, cancellation or wallet errors
never return a signature. History/audit/notification records do not contain the signing payload.
A signature can remain usable outside this app; rejecting a later request does not revoke prior signatures.

The TypeScript library provides `requestSignMessage` and `requestSignTypedData`, resolving to that signature.
Both take `chain_id`, optional `context`, `timeout_ms`, `join_timeout_ms` and `signal` with the same
waiting/cancellation semantics as `requestTx`. Bitcoin/chia pairings and invalid input throw
`InvalidTxError` before sending. No new CLI signature command or Python signing API is provided.

```typescript
const signature = await wallet.requestSignMessage({
  chain_id: 84532,
  message: 'Confirm ownership for this test session',
  context: { reason: 'prove ownership for a test login' },
})
const typedSignature = await wallet.requestSignTypedData({
  chain_id: 84532,
  typed_data: {
    domain: { chainId: 84532 },
    types: {
      EIP712Domain: [{ name: 'chainId', type: 'uint256' }],
      Session: [{ name: 'purpose', type: 'string' }],
    },
    primaryType: 'Session',
    message: { purpose: 'test login' },
  },
  context: { reason: 'sign the test session terms' },
})
```

Signature requests require a web UI with signature support. Older transaction-only web versions ignore
them without offering a wallet action; if no signature card appears, wait for the compatible web release
rather than repeatedly sending requests.

`request_token_transfer` uses the browser-safe `clanker-wallet/tokens` list (chain id, symbol, address, decimals). Unlisted symbols are refused: pass the contract address; never search by symbol. Unlisted contracts must answer both `decimals()` and `symbol()` via RPC. Excess fraction digits are refused, never rounded. The review card reads unlisted token metadata independently and warns with the full contract address; a reported symbol matching a listed token at another address is a danger flag, not an identity check.

`get_balance` needs no pairing and can check any recipient: EVM native/ERC-20 through RPC; bitcoin via `mempool.space` on mainnet/testnet/signet (includes mempool deltas, which can be negative); chia via keyless `api.coinset.org` / `testnet11.api.coinset.org` coin records on mainnet/testnet11. Chia addresses are decoded with the package's bech32 implementation; only unspent coins at that puzzle hash are summed, not every address in a wallet, not mempool or guaranteed spendability. Coin uint64 values stay exact; older runtimes without JSON source context refuse unsafe numeric amounts rather than round. Providers may lag or be unavailable. After a chia approval without a hash, call `get_balance` on the recipient; compare against a prior balance where possible, since a balance alone cannot prove which payment arrived.

`get_tx_status` reports EVM receipt success/failure plus confirmations, or bitcoin confirmations. No receipt is `pending_or_unknown`, not proof of submission; bitcoin can be `pending`, `confirmed` or `unknown`. Reads never sign or send transactions. Chain response bodies are stream-limited to 1 MiB (1,048,576 bytes); Chia replies also allow at most 10,000 coin records. Oversized responses are canceled and refused explicitly, never truncated into a partial balance. Addresses with larger coin histories must be checked using a provider/wallet with appropriate limits; this tool does not paginate or return a partial sum. These bounds supplement provider limits and the request timeout, not a guarantee of provider availability. The hosted connector shares a 60-per-minute per-grant chain-read budget across both read tools and token preparation; local servers use the provider's limits. Full multi-chain transaction history remains out of scope: it would need indexed transfer/transaction providers (typically keyed EVM APIs), pagination/backfills and wallet/address indexing; no keyed API is introduced here.

Chain RPC URLs are keyless public defaults for Ethereum, Base, Arbitrum, Optimism, Polygon and their configured testnets. Override per chain with the `rpcUrls` option or `CLANKER_WALLET_RPC_URLS` (JSON object of chain id to HTTP(S) URL); the hosted connector uses `RPC_URLS` in the same format. Keep keyed URLs in private deployment configuration. RPC services see queried contracts; token metadata is untrusted.

Show the user the `review_url` returned by request tools (also present on pending `get_request` results). It opens `https://clanker-wallet.xyz/?request=<request_id>` and highlights the card after the wallet loads its waiting requests; unknown ids are silently ignored. The link contains only the request id, not pairing secrets. Local MCP servers can override the origin with `webOrigin` or `CLANKER_WALLET_WEB_ORIGIN`.

Requests are asynchronous: a request tool returns once the relay has the request, then the assistant calls `get_request` (with `wait_seconds` to wait for an answer) until the status is no longer `pending`. Invalid input or a missing pairing is a tool error, and nothing is sent. Pending requests live in the server process: after 1 h the server stops waiting and reports `expired`, and a restarted server no longer knows them (`get_request` then reports an unknown `request_id`). In both cases the human may still approve the request in their wallet, so ask them before sending it again. `unknown` means the request was delivered but the server lost its relay connection: the human may still approve it, so ask them before sending it again. A chia approval may have no `tx_hash`: the Sage wallet sends without reporting a transaction id, so check the recipient's balance.

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

It throws `InvalidTxError` before sending for an evm pairing, an unknown network, a recipient from another network, a non-integer amount, or a bitcoin `fee` (the wallet sets bitcoin fees). Chia `fee` defaults to `"0"`. It returns `undefined` for a chia send the wallet reported no id for (Sage); check the recipient's balance.

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
