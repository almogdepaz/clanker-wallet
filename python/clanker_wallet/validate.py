"""Tx and transfer request validation — mirrors src/validate.ts."""

from __future__ import annotations

import re
from typing import Any, Optional, Tuple

from ._keccak import keccak256
from .bech32 import decode_chia_address, decode_segwit_address
from .errors import InvalidTxError
from .types import Transaction, Transfer

_ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]{40}")
_DECIMAL_RE = re.compile(r"[0-9]+")
_CALLDATA_RE = re.compile(r"0x(?:[0-9a-fA-F]{2})*")


def _shown(v: Any) -> str:
    """Short rendering of a rejected input for error messages."""
    s = repr(v)
    return s if len(s) <= 70 else s[:67] + "..."


def is_checksum_address(address: str) -> bool:
    """EIP-55: a mixed-case address must carry the checksum; single-case addresses are unchecksummed."""
    if not _ADDRESS_RE.fullmatch(address):
        return False
    body = address[2:]
    if body in (body.lower(), body.upper()):
        return True
    lower = body.lower()
    digest = keccak256(lower.encode("ascii")).hex()
    expected = "".join(ch.upper() if int(digest[i], 16) >= 8 else ch for i, ch in enumerate(lower))
    return body == expected


def validate_tx(chain_id: Any, transaction: Transaction) -> Tuple[int, Transaction]:
    """Check a tx request before anything is signed or sent.

    Returns (chain_id, transaction) normalized to the wire format: value as a decimal
    wei string, data defaulting to "0x". Raises InvalidTxError naming the first bad field.
    """
    # bool is an int subclass; True is not a chain id or an amount
    if type(chain_id) is not int or chain_id <= 0:
        raise InvalidTxError("chain_id", f"must be a positive integer, got {_shown(chain_id)}")

    to, value, data = transaction.to, transaction.value, transaction.data
    if not isinstance(to, str) or not _ADDRESS_RE.fullmatch(to):
        raise InvalidTxError("to", f"must be 0x followed by 40 hex characters, got {_shown(to)}")
    if not is_checksum_address(to):
        raise InvalidTxError("to", f"mixed-case address fails its EIP-55 checksum, got {_shown(to)}")

    if type(value) is int and value >= 0:
        wei = str(value)
    elif isinstance(value, str) and _DECIMAL_RE.fullmatch(value):
        wei = value
    else:
        raise InvalidTxError(
            "value",
            f"must be a non-negative integer amount of wei (decimal string or int), got {_shown(value)}",
        )

    if not isinstance(data, str) or not _CALLDATA_RE.fullmatch(data):
        raise InvalidTxError(
            "data", f"must be 0x followed by an even number of hex characters, got {_shown(data)}"
        )

    return chain_id, Transaction(to=to, value=wei, data=data)


_TRANSFER_ASSET = {"bitcoin": "btc", "chia": "xch"}

# address hrp per network; the web app checks the same table
_ADDRESS_HRP = {
    "bitcoin": {"mainnet": "bc", "testnet": "tb", "signet": "tb"},
    "chia": {"mainnet": "xch", "testnet11": "txch"},
}

_NETWORK_NAMES = {"bitcoin": "mainnet, testnet or signet", "chia": "mainnet or testnet11"}

_POSITIVE_INT_RE = re.compile(r"[1-9][0-9]*")

# the bitcoin wallet api takes sats as a js number
_MAX_SAFE_INTEGER = 2**53 - 1


def _units(v: Any, allow_zero: bool) -> Optional[str]:
    """A decimal string or int amount as a decimal string, or None."""
    # bool is an int subclass; True is not an amount
    if type(v) is int:
        return str(v) if v > 0 or (allow_zero and v == 0) else None
    if not isinstance(v, str):
        return None
    return v if _POSITIVE_INT_RE.fullmatch(v) or (allow_zero and v == "0") else None


def validate_transfer(chain_family: Any, chain_network: Any, transfer: Transfer) -> Tuple[str, str, Transfer]:
    """Check a bitcoin / chia transfer before anything is signed or sent.

    Returns (chain_family, chain_network, transfer) normalized to the wire format: amounts
    as decimal strings, the chia fee defaulting to "0". The recipient must decode as an
    address on chain_network. As strict as the web app, so a request it would refuse never
    leaves the agent. Raises InvalidTxError naming the first bad field.
    """
    if chain_family not in _TRANSFER_ASSET:
        raise InvalidTxError(
            "chain_family", f"transfers need a bitcoin or chia pairing, got {_shown(chain_family or 'evm')}"
        )
    family: str = chain_family
    hrp = _ADDRESS_HRP[family].get(chain_network) if isinstance(chain_network, str) else None
    if hrp is None:
        raise InvalidTxError("chain_network", f"must be {_NETWORK_NAMES[family]}, got {_shown(chain_network)}")
    network: str = chain_network

    asset = _TRANSFER_ASSET[family]
    if transfer.asset != asset:
        raise InvalidTxError("asset", f"{family} transfers must be {_shown(asset)}, got {_shown(transfer.asset)}")

    unit = "sats" if family == "bitcoin" else "mojos"
    amount = _units(transfer.amount, False)
    if amount is None:
        raise InvalidTxError(
            "amount",
            f"must be a positive integer amount of {unit} (decimal string or int), got {_shown(transfer.amount)}",
        )

    to = transfer.to
    if family == "bitcoin":
        if transfer.fee is not None:
            raise InvalidTxError("fee", "bitcoin transfers take no fee; the wallet sets it")
        if int(amount) > _MAX_SAFE_INTEGER:
            raise InvalidTxError("amount", f"must be at most {_MAX_SAFE_INTEGER} sats, got {_shown(amount)}")
        if not isinstance(to, str) or decode_segwit_address(hrp, to) is None:
            raise InvalidTxError("to", f"not a bitcoin {network} address (segwit, {hrp}1...), got {_shown(to)}")
        return family, network, Transfer(asset=asset, to=to, amount=amount)

    fee = "0" if transfer.fee is None else _units(transfer.fee, True)
    if fee is None:
        raise InvalidTxError(
            "fee", f"must be a non-negative integer amount of mojos (decimal string or int), got {_shown(transfer.fee)}"
        )
    if not isinstance(to, str) or decode_chia_address(hrp, to) is None:
        raise InvalidTxError("to", f"not a chia {network} address ({hrp}1...), got {_shown(to)}")
    return family, network, Transfer(asset=asset, to=to, amount=amount, fee=fee)
