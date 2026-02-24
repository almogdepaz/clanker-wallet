"""Error types for Clanker Wallet SDK."""


class ClankerError(Exception):
    """Base error for all Clanker Wallet SDK errors."""


class NotPairedError(ClankerError):
    """Raised when requesting a tx before pairing."""

    def __init__(self) -> None:
        super().__init__("not paired — call pair() first")


class TxRejectedError(ClankerError):
    """Raised when the human rejects a transaction."""

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        super().__init__(f"request {request_id} rejected by human")


class TxTimeoutError(ClankerError):
    """Raised when a transaction request times out."""

    def __init__(self, request_id: str, timeout_ms: int) -> None:
        self.request_id = request_id
        self.timeout_ms = timeout_ms
        super().__init__(f"request {request_id} timed out after {timeout_ms}ms")


class TxError(ClankerError):
    """Raised when a transaction fails on-chain."""

    def __init__(self, request_id: str, error: str) -> None:
        self.request_id = request_id
        self.error = error
        super().__init__(f"request {request_id} failed: {error}")


class PairingError(ClankerError):
    """Raised when pairing data is invalid."""


class RelayError(ClankerError):
    """Raised on relay connection errors."""
