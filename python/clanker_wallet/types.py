"""Wire protocol types for Clanker Wallet SDK.

Mirrors sdk/src/types.ts — Transaction, TxRequest, Transfer, TransferRequest,
TxResponse, AgentEnvelope, PairingData.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional, Union


@dataclass(slots=True)
class Transaction:
    """Transaction to send on-chain."""

    to: str
    value: Union[str, int]  # wei, as a decimal string or int; sent as a decimal string
    data: str = "0x"  # hex-encoded calldata


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
class Transfer:
    """A bitcoin / chia transfer to one recipient. The human's wallet builds, signs and broadcasts it."""

    asset: str  # "btc" | "xch"
    to: str  # recipient on the pairing's network (bc1/tb1 segwit, xch1/txch1)
    amount: Union[str, int]  # sats or mojos, as a decimal string or int; sent as a decimal string
    # chia only, in mojos (default "0"); bitcoin fees are set by the wallet
    fee: Optional[Union[str, int]] = None


@dataclass(slots=True)
class TransferRequest:
    """Bitcoin / chia transfer request sent to the human (matches web app NonEvmTxRequest)."""

    request_id: str
    agent_id: str
    timestamp: str  # ISO 8601
    chain_family: str  # "bitcoin" | "chia"
    chain_network: str  # bitcoin: mainnet | testnet | signet; chia: mainnet | testnet11
    transfer: Transfer
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
    wallet: str  # the human's address on the pairing's chain
    # "encrypted" (default): relay sees only ciphertext. "managed": relay also receives tx params for simulation.
    mode: Optional[str] = None
    chain_family: Optional[str] = None  # "bitcoin" | "chia"; absent for evm
    chain_network: Optional[str] = None  # the network the human's wallet is on, when the pairing names one


@dataclass(slots=True)
class RequestTxOptions:
    """Options for ClankerWallet.request_tx()."""

    chain_id: int
    transaction: Transaction
    context: Optional[TxContext] = None
    timeout_ms: Optional[int] = None  # default: 1 hour


@dataclass(slots=True)
class RequestTransferOptions:
    """Options for ClankerWallet.request_transfer()."""

    chain_network: str
    transfer: Transfer
    context: Optional[TxContext] = None
    timeout_ms: Optional[int] = None  # default: 1 hour


def _context_to_dict(context: Optional[TxContext]) -> Dict[str, Any]:
    """The context fields that are set; empty when there are none."""
    if context is None:
        return {}
    return {k: v for k, v in asdict(context).items() if v is not None}


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
    ctx = _context_to_dict(req.context)
    if ctx:
        d["context"] = ctx
    return d


def _transfer_request_to_dict(req: TransferRequest) -> Dict[str, Any]:
    """Serialize TransferRequest like _tx_request_to_dict: no fee key when unset, no empty context."""
    d: Dict[str, Any] = {
        "request_id": req.request_id,
        "agent_id": req.agent_id,
        "timestamp": req.timestamp,
        "chain_family": req.chain_family,
        "chain_network": req.chain_network,
        "transfer": {k: v for k, v in asdict(req.transfer).items() if v is not None},
        "signature": req.signature,
    }
    ctx = _context_to_dict(req.context)
    if ctx:
        d["context"] = ctx
    return d
