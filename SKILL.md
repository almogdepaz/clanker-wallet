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

Before you can send transactions, you must pair with the human. Ask them:

> "I need to send blockchain transactions on your behalf. Please go to https://clanker-wallet.xyz, connect your wallet, and give me the pairing JSON."

The human will give you a JSON string like:
```json
{"version":1,"pubkey":"ab12cd...","relay":"wss://clanker-wallet-relay-625052130878.us-east1.run.app/ws","wallet":"0x..."}
```

Pair with it:
```bash
clanker-wallet pair '{"version":1,"pubkey":"ab12...","relay":"wss://...","wallet":"0x..."}'
```

This saves identity and pairing to `~/.clanker-wallet/`. You only need to do this once.

### Transaction notifications

After pairing, ask the human:

> "Would you like me to notify you here when I need a transaction approved? I'll send you a message with a direct link to approve it."

If they agree, **every time you send a `tx` command**, immediately send a message through your current communication channel with:

1. A short description of what the tx does (from the `--reason`)
2. A direct link to the web app: **https://clanker-wallet.xyz**
3. The urgency level

Example notification:
> Transaction awaiting your approval
> I'm requesting to send 0.001 ETH on Sepolia to a test address.
> Urgency: normal
> [Approve or reject here](https://clanker-wallet.xyz)

## Sending a Transaction

```bash
clanker-wallet tx \
  --chain 1 \
  --to 0xRecipientAddress \
  --value 1000000000000000 \
  --reason "Send 0.001 ETH to recipient" \
  --urgency medium \
  --timeout 120000
```

The command **blocks until the human approves or rejects**. Output is JSON:
- Approved: `{"tx_hash":"0x...","status":"approved"}` (exit code 0)
- Rejected: `{"status":"rejected","error":"..."}` (exit code 1)
- Timeout: `{"status":"timeout","error":"..."}` (exit code 2)

## Critical Details

- **value is in WEI, not ETH.** 1 ETH = `1000000000000000000`. Use string, not number.
- **data is hex-encoded calldata.** Use `0x` for simple ETH transfers. For contract calls, encode the function call.
- **The human must be online to approve.** Set a reasonable `--timeout`. Always notify the human through your communication channel when you send a request (if they opted in).

## tx Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--chain <id>` | yes | — | Chain ID (1=Ethereum, 137=Polygon, 8453=Base) |
| `--to <address>` | yes | — | Recipient address |
| `--value <wei>` | no | `0` | Value in wei |
| `--data <hex>` | no | `0x` | Calldata hex |
| `--reason <text>` | no | — | Shown to human |
| `--urgency <level>` | no | — | `low`, `medium`, or `high` |
| `--expected-outcome <text>` | no | — | What will happen |
| `--timeout <ms>` | no | `3600000` | How long to wait |

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
```bash
clanker-wallet tx --chain 1 --to 0xRecipientAddress --value 1000000000000000 --reason "Send 0.001 ETH"
```

### ERC-20 token transfer
```bash
# transfer(address to, uint256 amount) — selector 0xa9059cbb
# encode to + amount as 32-byte padded hex
clanker-wallet tx \
  --chain 1 \
  --to 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --data 0xa9059cbb000000000000000000000000RecipientAddr00000000000000000000000000000000000000000000000000000000000f4240 \
  --reason "Transfer 1 USDC"
```

### ERC-20 approval
```bash
# approve(address spender, uint256 amount) — selector 0x095ea7b3
clanker-wallet tx \
  --chain 1 \
  --to 0xTokenContractAddress \
  --data 0x095ea7b3000000000000000000000000SpenderAddr0000000000000000000000000000000000000000000000000000000000000f4240 \
  --reason "Approve 1 USDC spend for DeFi protocol"
```

## Other Commands

```bash
# Check pairing status
clanker-wallet status
# → {"agent_id":"agent_abc123","paired":true,"wallet":"0x...","relay":"wss://..."}

# Show agent identity
clanker-wallet whoami
# → {"agent_id":"agent_abc123","public_key":"ab12cd..."}
```

## Troubleshooting

- **exit code 4 / "not paired"** — run `clanker-wallet pair '<JSON>'` first
- **exit code 2 / timeout** — human didn't respond in time, increase `--timeout` or ask them to check the web app
- **exit code 1 / "rejected"** — human clicked reject. Explain why the tx is needed and try again if appropriate.
- **exit code 3 / connection error** — relay may be down, try again in a few seconds
