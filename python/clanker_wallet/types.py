"""Wire protocol types for Clanker Wallet SDK.

Mirrors sdk/src/types.ts — Transaction, TxRequest, TxResponse,
AgentEnvelope, PairingData.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional


@dataclass(slots=True)
class Transaction:
    """Transaction to send on-chain."""

    to: str
    value: str  # wei string
    data: str  # hex-encoded calldata


@dataclass(slots=True)
class TxContext:
    """Optional context about the transaction."""

    reason: Optional[str] = None
    urgency: Optional[str] = None
    expected_outcome: Optional[str] = None


@dataclass(slots=True)
class TxRequest:
    """Full tx request sent to the human (matches web app TxRequest)."""

    request_id: str
    agent_id: str
    timestamp: str  # ISO 8601
    chain_id: int
    transaction: Transaction
    signature: str
    context: Optional[TxContext] = None


@dataclass(slots=True)
class TxResponse:
    """Response from the human (decrypted)."""

    request_id: str
    status: str  # "approved" | "rejected"
    tx_hash: Optional[str] = None
    error: Optional[str] = None


@dataclass(slots=True)
class AgentEnvelope:
    """Wire format sent over relay."""

    sender_pubkey: str  # x25519 pubkey (hex)
    ciphertext: str  # base64(nonce + ciphertext)
    signing_pubkey: Optional[str] = None  # Ed25519 pubkey (hex)


@dataclass(slots=True)
class PairingData:
    """Pairing data from QR code."""

    version: int
    pubkey: str  # human's x25519 pubkey (hex)
    relay: str  # ws:// relay URL
    wallet: str  # 0x... address


@dataclass(slots=True)
class RequestTxOptions:
    """Options for ClankerWallet.request_tx()."""

    chain_id: int
    transaction: Transaction
    context: Optional[TxContext] = None
    timeout_ms: Optional[int] = None  # default: 1 hour


def _tx_request_to_dict(req: TxRequest) -> Dict[str, Any]:
    """Serialize TxRequest to a JSON-compatible dict.

    Matches the TS JSON.stringify() output: omits None context,
    uses camelCase-free field names (already snake_case = wire format).
    """
    d: Dict[str, Any] = {
        "request_id": req.request_id,
        "agent_id": req.agent_id,
        "timestamp": req.timestamp,
        "chain_id": req.chain_id,
        "transaction": asdict(req.transaction),
        "signature": req.signature,
    }
    if req.context is not None:
        ctx = {k: v for k, v in asdict(req.context).items() if v is not None}
        if ctx:
            d["context"] = ctx
    return d
