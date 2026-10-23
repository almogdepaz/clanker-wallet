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

This saves identity and pairing to `~/.clanker-wallet/`. You only need to do this once.

### Trust (first request)

The web app lists a new agent as unverified and shows its fingerprint (e.g. `ab12 cd34 ef56 7890`). Until the human compares it with the `fingerprint` from `clanker-wallet whoami` and clicks "trust this agent", none of their auto-approve rules apply: every tx waits for manual approval. Contract rules (contract address + allowed methods) do not limit token amounts or recipients: a rule allowing `transfer` on a token auto-approves any amount to any recipient. If asked, run `clanker-wallet whoami` and share the fingerprint.

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

The command **blocks until the human approves or rejects**, for up to 1 hour by default. Pass `--timeout <ms>` to wait a different time (`600000` = 10 minutes). Output is JSON:
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
# → {"agent_id":"agent_abc123","paired":true,"wallet":"0x...","relay":"wss://..."}

# Show agent identity
clanker-wallet whoami
# → {"agent_id":"agent_abc123","public_key":"ab12cd34ef567890...","fingerprint":"ab12 cd34 ef56 7890"}
```

## Troubleshooting

- **exit code 5 / "invalid --flag: ..."** — fix the named flag; nothing was sent. Usually a placeholder `--to`, a `--value` in ETH instead of wei, or `--data` that isn't even-length hex
- **exit code 4 / "not paired"** — run `clanker-wallet pair '<JSON>'` first
- **exit code 2 / timeout** — human didn't respond in time, increase `--timeout` or ask them to check the web app
- **exit code 1 / "rejected"** — human clicked reject. Explain why the tx is needed and try again if appropriate.
- **exit code 3 / connection error** — relay may be down, try again in a few seconds
