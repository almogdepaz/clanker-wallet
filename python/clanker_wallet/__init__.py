"""Clanker Wallet Python SDK — E2E encrypted transaction approval for AI agents."""

__version__ = "0.1.0"

from .client import ClankerWallet
from .crypto import (
    generate_keypair,
    keypair_from_secret,
    encrypt_message,
    decrypt_message,
    signing_keypair_from_seed,
    sign_message,
    verify_signature,
    to_hex,
    from_hex,
    bytes_to_base64,
    base64_to_bytes,
)
from .errors import (
    ClankerError,
    InvalidTxError,
    NotPairedError,
    TxRejectedError,
    TxTimeoutError,
    TxError,
    PairingError,
    RelayError,
)
from .types import (
    Transaction,
    TxContext,
    TxRequest,
    TxResponse,
    AgentEnvelope,
    PairingData,
    RequestTxOptions,
)
from .validate import is_checksum_address, validate_tx

__all__ = [
    "__version__",
    # client
    "ClankerWallet",
    # types
    "Transaction",
    "TxContext",
    "TxRequest",
    "TxResponse",
    "AgentEnvelope",
    "PairingData",
    "RequestTxOptions",
    # validation
    "validate_tx",
    "is_checksum_address",
    # crypto
    "generate_keypair",
    "keypair_from_secret",
    "encrypt_message",
    "decrypt_message",
    "signing_keypair_from_seed",
    "sign_message",
    "verify_signature",
    "to_hex",
    "from_hex",
    "bytes_to_base64",
    "base64_to_bytes",
    # errors
    "ClankerError",
    "InvalidTxError",
    "NotPairedError",
    "TxRejectedError",
    "TxTimeoutError",
    "TxError",
    "PairingError",
    "RelayError",
]
