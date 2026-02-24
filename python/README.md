# clanker-wallet

Python SDK for [Clanker Wallet](https://github.com/almogdepaz/clanker-wallet) — E2E encrypted transaction approval for AI agents.

An AI agent proposes transactions, a human reviews and signs them via the web app. All communication is end-to-end encrypted using x25519 + nacl.box.

## Install

```bash
pip install clanker-wallet
```

Requires Python 3.10+.

## Quick Start

```python
import asyncio
from clanker_wallet import ClankerWallet, Transaction, RequestTxOptions, TxContext

async def main():
    # Create agent (generates new x25519 identity keypair)
    agent = ClankerWallet()

    # Pair with human's wallet (QR data from the web app)
    agent.pair(qr_data_string)

    # Request a transaction
    tx_hash = await agent.request_tx(RequestTxOptions(
        chain_id=1,
        transaction=Transaction(
            to="0xRecipient...",
            value="1000000000000000000",  # 1 ETH in wei
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

#### `pair(qr_data: str) -> PairingData`

Parse QR / pairing JSON from the web app. Stores the human's public key and relay URL.

```python
pairing = agent.pair('{"version":1,"pubkey":"ab12...","relay":"wss://relay.example/ws","wallet":"0x..."}')
print(pairing.relay)   # wss://relay.example/ws
print(pairing.wallet)  # 0x...
```

Raises `PairingError` if JSON is invalid or version != 1.

#### `async request_tx(options: RequestTxOptions) -> str`

Send an encrypted transaction request to the paired human. Blocks until the human approves, rejects, or the timeout expires.

Returns the on-chain transaction hash on approval.

```python
tx_hash = await agent.request_tx(RequestTxOptions(
    chain_id=1,
    transaction=Transaction(to="0x...", value="0", data="0x"),
    context=TxContext(reason="swap tokens"),
    timeout_ms=60_000,  # 1 minute (default: 1 hour)
))
```

### Types

All types are `dataclass(slots=True)` for performance.

#### `Transaction`

```python
Transaction(to: str, value: str, data: str)
```

- `to` — recipient address (0x-prefixed)
- `value` — wei amount as string (not int)
- `data` — hex-encoded calldata (0x-prefixed)

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

#### `PairingData`

Returned by `pair()`.

```python
PairingData(version: int, pubkey: str, relay: str, wallet: str)
```

### Errors

All errors inherit from `ClankerError`.

| Error | When | Attributes |
|-------|------|------------|
| `ClankerError` | Base class | — |
| `NotPairedError` | `request_tx()` called before `pair()` | — |
| `TxRejectedError` | Human rejected the transaction | `request_id` |
| `TxTimeoutError` | No response within timeout | `request_id`, `timeout_ms` |
| `TxError` | Transaction failed on-chain | `request_id`, `error` |
| `PairingError` | Invalid pairing data | — |
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

1. Human opens the web app, connects wallet, derives an x25519 keypair, displays QR code
2. Agent calls `pair(qr_data)` — stores human's public key + relay URL
3. Agent calls `request_tx()` — encrypts a `TxRequest` with nacl.box, sends via WebSocket relay
4. Human's web app decrypts, displays tx details, runs simulation/risk checks
5. Human approves → wallet signs + broadcasts → encrypted `TxResponse` with tx hash sent back
6. Agent receives tx hash, returns it from `request_tx()`

All messages are encrypted end-to-end. The relay server never sees plaintext.

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
