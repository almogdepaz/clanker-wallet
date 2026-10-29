# clanker-wallet

Python SDK for [Clanker Wallet](https://github.com/almogdepaz/clanker-wallet) — E2E encrypted transaction approval for AI agents.

An AI agent proposes transactions, a human reviews and signs them via the web app. All communication is end-to-end encrypted using x25519 + nacl.box. EVM chains take raw transactions (`request_tx`); bitcoin and chia take transfers (`request_transfer`) that the human's wallet builds.

## Install

```bash
pip install clanker-wallet
```

Requires Python 3.10+.

`request_tx()` and `request_transfer()` open a WebSocket to the relay in the pairing JSON (`wss://relay.clanker-wallet.xyz/ws`). In a sandbox or behind a firewall, allow that host, or it raises `RelayError`. `HTTPS_PROXY` is honored with websockets 15 or newer.

## Quick Start

```python
import asyncio
from clanker_wallet import ClankerWallet, Transaction, RequestTxOptions, TxContext

async def main():
    # Create agent (generates new x25519 identity keypair)
    agent = ClankerWallet()

    # Pair with human's wallet — JSON from the prompt the human pasted
    # (or scanned from the QR on https://clanker-wallet.xyz)
    agent.pair(pairing_json)

    # Request a transaction: 0.001 ETH on Base Sepolia
    tx_hash = await agent.request_tx(RequestTxOptions(
        chain_id=84532,
        transaction=Transaction(
            to="0x000000000000000000000000000000000000dEaD",
            value="1000000000000000",  # 0.001 ETH in wei
            data="0x",
        ),
        context=TxContext(reason="Payment for service"),
    ))
    print(f"Approved: {tx_hash}")

asyncio.run(main())
```

## Persistence

Save and restore agent identity across sessions:

```python
# Save the 32-byte secret key (store securely)
secret = agent.secret_key

# Restore later — same keypair, same agent_id
agent = ClankerWallet(secret_key=secret)
```

## API Reference

### `ClankerWallet`

The main client class. Each instance represents an AI agent identity.

```python
ClankerWallet(*, agent_name=None, secret_key=None)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_name` | `str \| None` | Optional display name for this agent |
| `secret_key` | `bytes \| None` | 32-byte x25519 secret key to restore identity. Omit to generate new. |

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `public_key` | `bytes` | 32-byte x25519 public key |
| `secret_key` | `bytes` | 32-byte x25519 secret key |
| `signing_public_key` | `bytes` | 32-byte Ed25519 public key (derived from secret) |
| `agent_id` | `str` | Deterministic ID: `agent_{pubkey_hex[:12]}` |
| `paired` | `bool` | Whether `pair()` has been called |

**Methods:**

#### `pair(pairing_json: str) -> PairingData`

Parse the pairing JSON from the web app (also matches what the QR code encodes). Stores the human's public key and relay URL.

```python
pairing = agent.pair('{"version":1,"pubkey":"ab12...","relay":"wss://relay.example/ws","wallet":"0x..."}')
print(pairing.relay)   # wss://relay.example/ws
print(pairing.wallet)  # 0x...
```

Raises `PairingError` if JSON is invalid or version != 1. The web app's bitcoin and chia tabs give pairing JSON with `"chain_family":"bitcoin"` / `"chain_family":"chia"`; it is kept in `PairingData.chain_family` and decides what `request_transfer()` sends.

#### `async request_tx(options: RequestTxOptions) -> str`

Send an encrypted transaction request to the paired human. Blocks until the human approves, rejects, or the timeout expires.

Returns the on-chain transaction hash on approval. Raises `InvalidTxError` before anything is sent if `chain_id`, `to`, `value` or `data` is malformed.

```python
tx_hash = await agent.request_tx(RequestTxOptions(
    chain_id=84532,
    transaction=Transaction(to="0x000000000000000000000000000000000000dEaD", value="0", data="0x"),
    context=TxContext(reason="swap tokens"),
    timeout_ms=60_000,  # 1 minute (default: 1 hour)
))
```

#### `async request_transfer(options: RequestTransferOptions) -> str`

Send bitcoin or chia through a bitcoin or chia pairing: the human's wallet builds, signs and broadcasts the transaction. Returns the bitcoin txid or chia transaction id on approval; rejection, timeout and relay errors raise as for `request_tx()`.

Raises `InvalidTxError` before anything is sent for an evm pairing, an unknown `chain_network`, a recipient from another network (bitcoin: segwit `bc1...`/`tb1...` only), a non-integer amount, or a bitcoin `fee` (bitcoin wallets set their own).

```python
from clanker_wallet import RequestTransferOptions, Transfer

# with a chia pairing: 1000 mojos on testnet11
tx_id = await agent.request_transfer(RequestTransferOptions(
    chain_network="testnet11",
    transfer=Transfer(asset="xch", to="txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg", amount=1000, fee=0),
    context=TxContext(reason="pay for the api call"),
))
```

### Types

All types are `dataclass(slots=True)` for performance.

#### `Transaction`

```python
Transaction(to: str, value: str | int, data: str = "0x")
```

- `to` — recipient address: `0x` + 40 hex characters; mixed case must pass the EIP-55 checksum
- `value` — whole number of wei, as a decimal string or int (not ETH, no decimals)
  (the js sdk takes a decimal string or `bigint` instead; a js `number` is rejected)
- `data` — calldata, `0x` + even-length hex (defaults to `0x`)

#### `TxContext`

Optional context to help the human understand the request.

```python
TxContext(reason=None, urgency=None, expected_outcome=None)
```

#### `RequestTxOptions`

```python
RequestTxOptions(chain_id: int, transaction: Transaction, context=None, timeout_ms=None)
```

- `timeout_ms` — defaults to 3,600,000 (1 hour)

#### `Transfer`

```python
Transfer(asset: str, to: str, amount: str | int, fee: str | int | None = None)
```

- `asset` — `"btc"` or `"xch"`, matching the pairing's family
- `to` — bech32/bech32m address on `chain_network`: `bc1...` (bitcoin mainnet), `tb1...` (testnet, signet), `xch1...`, `txch1...`
- `amount` — whole sats or mojos, as a decimal string or int (1 BTC = 100,000,000 sats; 1 XCH = 1,000,000,000,000 mojos)
- `fee` — chia only, in mojos; defaults to `0` and is shown to the human

#### `RequestTransferOptions`

```python
RequestTransferOptions(chain_network: str, transfer: Transfer, context=None, timeout_ms=None)
```

- `chain_network` — bitcoin: `"mainnet"`, `"testnet"`, `"signet"`; chia: `"mainnet"`, `"testnet11"`. There is no default network.

#### `PairingData`

Returned by `pair()`.

```python
PairingData(version: int, pubkey: str, relay: str, wallet: str, mode: str | None = None, chain_family: str | None = None, chain_network: str | None = None)
```

- `mode` — `"managed"` (the relay also gets the tx fields to simulate) or `"encrypted"` / `None` (ciphertext only)
- `chain_family` — `"bitcoin"` or `"chia"`; `None` for an evm pairing
- `chain_network` — set when the pairing names one; `request_transfer()` then refuses other networks

### Errors

All errors inherit from `ClankerError`.

| Error | When | Attributes |
|-------|------|------------|
| `ClankerError` | Base class | — |
| `NotPairedError` | `request_tx()` / `request_transfer()` called before `pair()` | — |
| `TxRejectedError` | Human rejected the transaction | `request_id` |
| `TxTimeoutError` | No response within timeout | `request_id`, `timeout_ms` |
| `TxError` | Transaction failed on-chain | `request_id`, `error` |
| `PairingError` | Invalid pairing data | — |
| `InvalidTxError` | Malformed tx or transfer request (also a `ValueError`); nothing was sent | `field`, `reason` |
| `RelayError` | WebSocket connection issues | — |

```python
from clanker_wallet import TxRejectedError, TxTimeoutError, TxError

try:
    tx_hash = await agent.request_tx(options)
except TxRejectedError:
    print("Human said no")
except TxTimeoutError as e:
    print(f"Timed out after {e.timeout_ms}ms")
except TxError as e:
    print(f"On-chain failure: {e.error}")
```

### Crypto Utilities

Low-level crypto functions are exported for advanced use cases (e.g. building custom protocols on top of the relay).

```python
from clanker_wallet import (
    generate_keypair,      # -> BoxKeyPair (x25519)
    keypair_from_secret,   # bytes -> BoxKeyPair
    encrypt_message,       # (msg, recipient_pub, sender_sk) -> base64
    decrypt_message,       # (b64, sender_pub, recipient_sk) -> str | None
    signing_keypair_from_seed,  # bytes -> SignKeyPair (Ed25519)
    sign_message,          # (msg, sk) -> base64 signature
    verify_signature,      # (msg, b64_sig, pk) -> bool
    to_hex, from_hex,      # bytes <-> hex
    bytes_to_base64, base64_to_bytes,
)
```

## How It Works

1. Human opens the web app, connects wallet, derives an x25519 keypair, copies a paste-ready prompt (or scans the QR) containing the pairing JSON
2. Agent calls `pair(pairing_json)` — stores human's public key + relay URL
3. Agent calls `request_tx()` — encrypts a `TxRequest` with nacl.box, sends via WebSocket relay
4. Human's web app decrypts, displays tx details, runs simulation/risk checks
5. Human approves → wallet signs + broadcasts → encrypted `TxResponse` with tx hash sent back
6. Agent receives tx hash, returns it from `request_tx()`

All messages are encrypted end-to-end. The relay server never sees plaintext, except in managed mode (`PairingData.mode == "managed"`), where `request_tx()` also sends the transaction fields to the relay for simulation.

## Development

```bash
cd python
pip install -e ".[dev]"

# Run tests
pytest -v

# Type checking (strict mode)
mypy clanker_wallet/

# Build package
python -m build
```

## License

MIT
