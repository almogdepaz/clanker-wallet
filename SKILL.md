---
name: clanker-wallet
description: "Send blockchain transactions through a human-approved wallet. You propose tx, human reviews and signs. No private keys needed."
homepage: https://clanker-wallet.xyz
---

# Clanker Wallet — Human-Approved Transactions

You are an AI agent that needs to send blockchain transactions. You do NOT have a private key. Instead, you propose transactions and a human approves them from their own wallet.

## Setup

```bash
npm install -g clanker-wallet
```

Or use without installing: `npx clanker-wallet` / `bunx clanker-wallet`

### Running in a sandbox

If your commands run in a sandbox (e.g. Claude Code), the CLI needs:

- **network:** a WebSocket to the relay, `wss://relay.clanker-wallet.xyz/ws` (the `relay` URL in the pairing JSON). Without it `tx` fails with exit code 3.
- **the sandbox proxy:** if the sandbox only lets traffic out through `HTTPS_PROXY` (Claude Code does), Node ignores it unless you run the CLI as `NODE_USE_ENV_PROXY=1 clanker-wallet ...` (Node 24+). The exit-3 error says so when this applies.
- **files:** `pair` writes your identity and the pairing to `~/.clanker-wallet/`, and the other commands write there too (they fix file permissions and create the identity if it is missing). Allow writes, not just reads.

Ask the human to allow the host and the directory before you pair.

## Pairing (one-time)

Before you can send transactions, check if you're already paired:

```bash
clanker-wallet status
```

If `paired: true`, skip pairing.

The human will paste a prompt block from https://clanker-wallet.xyz that looks like this:

> read the setup guide first: https://clanker-wallet.xyz/llms.txt
>
> then pair using this code:
> `{"version":1,"pubkey":"ab12cd...","relay":"wss://...","wallet":"0x..."}`

Extract the JSON object (the line starting with `{`) and pair:

```bash
clanker-wallet pair '{"version":1,"pubkey":"ab12...","relay":"wss://...","wallet":"0x..."}'
```

If the human only pastes raw JSON (no prompt prose), pair with it directly. If they only paste the URL, ask them to click "copy prompt for agent" on the pairing screen.

`pair` writes your identity and the pairing to `~/.clanker-wallet/`. You only need to do this once per chain family.

The web app has an evm, a bitcoin and a chia tab, and each tab gives its own pairing JSON (bitcoin and chia add `"chain_family":"bitcoin"` / `"chain_family":"chia"`). Pair each one you need: every family is kept in its own file, `~/.clanker-wallet/pairings/<family>.json` (`evm`, `bitcoin`, `chia`), so pairing one never replaces another. A `~/.clanker-wallet/pairing.json` written by clanker-wallet 0.4.x is still read as the evm pairing and is left untouched.

If the JSON contains `"mode":"managed"`, the human chose managed mode: the relay simulates each transaction for the review screen, so `tx` also sends the plain transaction fields (from, to, value, data, chainId) to the relay, which shares them with its simulation provider. Without it (or with `"mode":"encrypted"`) the relay only sees ciphertext. Pair with the JSON exactly as given either way.

### Trust (first request)

The web app lists a new agent as unverified and shows its fingerprint (e.g. `ab12 cd34 ef56 7890`). Until the human compares it with the `fingerprint` from `clanker-wallet whoami` and clicks "trust this agent", none of their auto-approve rules apply: every tx waits for manual approval. Trust applies on every chain family; each chain family has its own policy (rules and remote URL), edited while that chain is selected. Value and daily limits come in two units: wei limits apply to evm only, sats limits to bitcoin only (they count the sent amount, not the fee the wallet adds); a `send` on any other family never matches a rule that sets one and waits for the human. Chia has no value limits. On bitcoin the wallet still asks the human to confirm each auto-approved `send`. Contract rules (contract address + allowed methods) do not limit token amounts or recipients: a rule allowing `transfer` on a token auto-approves any amount to any recipient. If asked, run `clanker-wallet whoami` and share the fingerprint.

### Transaction notifications

After pairing, ask the human:

> "Would you like me to notify you here when I need a transaction approved? I'll send you a message with a direct link to approve it."

If they agree, **every time you send a `tx` command**, immediately send a message through your current communication channel with:

1. A short description of what the tx does (from the `--reason`)
2. A direct link to the web app: **https://clanker-wallet.xyz**
3. The urgency level

Example notification:
> Transaction awaiting your approval
> I'm requesting to send 0.001 ETH on Base Sepolia to a test address.
> Urgency: normal
> [Approve or reject here](https://clanker-wallet.xyz)

## Sending a Transaction

```bash
clanker-wallet tx \
  --chain 84532 \
  --to 0x000000000000000000000000000000000000dEaD \
  --value 1000000000000000 \
  --reason "Send 0.001 ETH on Base Sepolia to a test address" \
  --urgency medium \
  --timeout 600000
```

This sends 0.001 ETH (`1000000000000000` wei) on Base Sepolia (chain `84532`) to the burn address `0x000000000000000000000000000000000000dEaD`.

The command **blocks until the human approves or rejects**, for up to 1 hour by default. Pass `--timeout <ms>` to wait a different time (`600000` = 10 minutes). If your shell tool kills commands after a few minutes, run `tx` in the background and read its output when it exits. Output is JSON:
- Approved: `{"tx_hash":"0x...","status":"approved"}` (exit code 0)
- Rejected: `{"status":"rejected","error":"..."}` (exit code 1)
- Timeout: `{"status":"timeout","error":"..."}` (exit code 2)
- Invalid `--chain`, `--to`, `--value`, `--data` or `--timeout`: a one-line `invalid --<flag>: ...` message on stderr and nothing is sent (exit code 5)

## Critical Details

- **value is in WEI, not ETH.** 1 ETH = `1000000000000000000`. A whole number: no decimals, no `1e18`.
- **data is hex-encoded calldata.** Use `0x` for simple ETH transfers. For contract calls, encode the function call (see ERC-20 transfer below). Never put placeholder text inside the hex.
- **to must be a real address**: `0x` + 40 hex characters. Mixed-case addresses must carry a valid EIP-55 checksum.
- **The human must be online to approve.** Set a reasonable `--timeout`. Always notify the human through your communication channel when you send a request (if they opted in).

## tx Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--chain <id>` | yes | — | Chain ID (1=Ethereum, 8453=Base, 84532=Base Sepolia) |
| `--to <address>` | yes | — | Recipient address |
| `--value <wei>` | no | `0` | Value in wei |
| `--data <hex>` | no | `0x` | Calldata hex |
| `--reason <text>` | no | — | Shown to human |
| `--urgency <level>` | no | — | `low`, `medium`, or `high` |
| `--expected-outcome <text>` | no | — | What will happen |
| `--timeout <ms>` | no | `3600000` (1 h) | How long `tx` blocks waiting for the human |

## Sending Bitcoin or Chia

Bitcoin and chia sends are transfers: you name the network, recipient and amount, and the human's wallet builds, signs and broadcasts the transaction. Pair the web app's bitcoin or chia tab first.

```bash
clanker-wallet send --btc testnet --to tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx --sats 1000 --reason "Send 1000 sats on bitcoin testnet"
clanker-wallet send --xch testnet11 --to txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg --mojos 1000 --fee-mojos 0 --reason "Send 1000 mojos on chia testnet11"
```

- **network:** `--btc mainnet|testnet|signet` or `--xch mainnet|testnet11`. There is no default network; the recipient must belong to it (`bc1...` on bitcoin mainnet, `tb1...` on testnet/signet, `xch1...` / `txch1...` on chia).
- **bitcoin recipients are segwit addresses only** (`bc1q...`, `bc1p...`, `tb1...`); legacy `1...`/`3...` addresses are refused.
- **amounts are whole base units**: `--sats` (1 BTC = `100000000`), `--mojos` (1 XCH = `1000000000000`). No decimals.
- **fees:** bitcoin fees are set in the human's wallet. Chia takes `--fee-mojos` (default `0`), which the human sees before approving.
- `--reason`, `--urgency`, `--expected-outcome` and `--timeout` work as for `tx`, and so do the output and exit codes. On approval `tx_hash` is the bitcoin txid or the chia transaction id. A chia approval may have no `tx_hash` (`{"status":"approved"}`): the Sage wallet sends without reporting a transaction id, so check the recipient's balance. Exit code 4 means that chain family isn't paired.

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

## Common Patterns

### Simple ETH transfer
```bash
clanker-wallet tx --chain 84532 --to 0x000000000000000000000000000000000000dEaD --value 1000000000000000 --reason "Send 0.001 ETH"
```

### ERC-20 token transfer
Calldata is the 4-byte selector followed by each argument as a 32-byte word: the address left-padded with zeros, the amount as big-endian hex in the token's smallest unit. This sends 0.001 WETH (`1000000000000000` = `0x38d7ea4c68000`, 18 decimals) on Base Sepolia, where WETH is `0x4200000000000000000000000000000000000006`:

```bash
# transfer(address to, uint256 amount) — selector 0xa9059cbb
clanker-wallet tx \
  --chain 84532 \
  --to 0x4200000000000000000000000000000000000006 \
  --data 0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000038d7ea4c68000 \
  --reason "Transfer 0.001 WETH to a test address"
```

Encode it with a library rather than by hand, e.g. `cast calldata "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1000000000000000` (foundry) or viem `encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] })`.

### ERC-20 approval
```bash
# approve(address spender, uint256 amount) — selector 0x095ea7b3
clanker-wallet tx \
  --chain 84532 \
  --to 0x4200000000000000000000000000000000000006 \
  --data 0x095ea7b3000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000038d7ea4c68000 \
  --reason "Approve a test address to spend 0.001 WETH"
```

## Other Commands

```bash
# Check pairing status
clanker-wallet status
# → {"agent_id":"agent_abc123","paired":true,"wallet":"0x...","relay":"wss://...",
#    "pairings":{"evm":{"wallet":"0x...","relay":"wss://...","mode":null,"chain_network":null},"chia":{"wallet":"xch1...",...}}}
# wallet and relay are the evm pairing's; pairings lists every paired chain family

# Show agent identity
clanker-wallet whoami
# → {"agent_id":"agent_abc123","public_key":"ab12cd34ef567890...","fingerprint":"ab12 cd34 ef56 7890"}
```

## MCP (assistants)

`clanker-wallet mcp` runs an MCP server over stdio, so an assistant (Claude Desktop, Claude Code, Cursor, or another MCP host that runs local commands) can ask for transactions as tool calls. The human approves every request on their own device; the server holds no wallet keys. It uses the CLI's identity and pairings in `~/.clanker-wallet/`, so pair first (`clanker-wallet pair '<JSON>'`, once per chain family). In a sandbox the server needs the same relay access and `~/.clanker-wallet/` writes as the CLI.

If your host supports MCP, the human can add the server instead of you running `tx` / `send`:

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
| `get_request` | `request_id`, optional `wait_seconds` (at most 50) | `status`: `pending`, `approved` (with `signature` for signing or `tx_hash` for transactions; a chia send may have none), `rejected`, `failed` (with `error`), `unknown` (with `error`) or `expired` |
| `get_balance` | `family`, `address` (any recipient), EVM `chain_id`, bitcoin/chia `network`, optional EVM `token` (listed symbol or address) | exact `raw_balance`, human `balance`, `asset`, `decimals`; bitcoin also confirmed/mempool deltas; chia recipient puzzle-hash unspent coins only |
| `get_tx_status` | `family` (evm/bitcoin), `tx_hash`, EVM `chain_id` or bitcoin `network` | receipt `status` and `confirmations`; missing EVM receipt is `pending_or_unknown`, missing bitcoin hash is `unknown` |
| `list_pairings` | none | `agent_id`, `fingerprint`, and the paired families (`evm`, `bitcoin`, `chia`) with network, wallet and mode |

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

Flow: call `list_pairings` to see which chains you can use, call `request_evm_tx` or `request_transfer` (same rules as `tx` / `send`: wei, sats and mojos as integer strings, real addresses), tell the human a request is waiting (see "Transaction notifications"), then call `get_request` with `wait_seconds` until the status is no longer `pending`. Invalid input or a missing pairing comes back as a tool error and nothing is sent. After 1 h the server stops waiting and reports `expired`, and a restarted server no longer knows its earlier requests (`get_request` then reports an unknown `request_id`). In both cases the human may still approve the request in their wallet, so ask them before sending it again. `unknown` means the request was delivered but the server lost its relay connection: the human may still approve it, so ask them before sending it again. A chia approval may have no `tx_hash`: the Sage wallet sends without reporting a transaction id, so check the recipient's balance.

## Troubleshooting

- **exit code 5 / "invalid --flag: ..."** — fix the named flag; nothing was sent. Usually a placeholder `--to`, a `--value` in ETH instead of wei, or `--data` that isn't even-length hex
- **exit code 4 / "not paired"** — run `clanker-wallet pair '<JSON>'` first (for `send`, with the JSON from the web app's bitcoin or chia tab)
- **exit code 2 / timeout** — human didn't respond in time, increase `--timeout` or ask them to check the web app
- **exit code 1 / "rejected"** — human clicked reject. Explain why the tx is needed and try again if appropriate.
- **exit code 3 / "relay connection error: could not reach wss://..."** — if you run in a sandbox or behind a firewall, allow that host (`relay.clanker-wallet.xyz` by default) and, if the error mentions it, rerun with `NODE_USE_ENV_PROXY=1` (see "Running in a sandbox"); otherwise the relay may be down or rate limiting, try again in a few seconds
