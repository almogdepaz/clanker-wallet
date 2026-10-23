"""Tx request validation — mirrors src/validate.ts."""

from __future__ import annotations

import re
from typing import Any, Tuple

from ._keccak import keccak256
from .errors import InvalidTxError
from .types import Transaction

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
