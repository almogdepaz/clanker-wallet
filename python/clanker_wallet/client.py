"""ClankerWallet client — pair with a human, request tx and transfer approvals.

Mirrors sdk/src/client.ts.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, Optional

import websockets
import websockets.asyncio.client

from .crypto import (
    BoxKeyPair,
    decrypt_message,
    encrypt_message,
    from_hex,
    generate_keypair,
    keypair_from_secret,
    sign_message,
    signing_keypair_from_seed,
    to_hex,
)
from .errors import (
    InvalidTxError,
    NotPairedError,
    PairingError,
    RelayError,
    TxError,
    TxRejectedError,
    TxTimeoutError,
)
from .types import (
    AgentEnvelope,
    PairingData,
    RequestTransferOptions,
    RequestTxOptions,
    TransferRequest,
    TxRequest,
    TxResponse,
    _transfer_request_to_dict,
    _tx_request_to_dict,
)
from .validate import validate_transfer, validate_tx

_DEFAULT_TIMEOUT_MS = 3_600_000  # 1 hour

_UNREACHABLE_HINT = (
    "if you run in a sandbox or behind a firewall, allow this host; "
    "otherwise the relay may be down or rate limiting, retry in a few seconds"
)


class ClankerWallet:
    """E2E encrypted wallet client for AI agents.

    Usage::

        wallet = ClankerWallet()
        wallet.pair(qr_json)
        tx_hash = await wallet.request_tx(RequestTxOptions(
            chain_id=84532,  # base sepolia
            transaction=Transaction(to="0x000000000000000000000000000000000000dEaD", value="1000"),
        ))
    """

    def __init__(
        self,
        *,
        agent_name: Optional[str] = None,
        secret_key: Optional[bytes] = None,
    ) -> None:
        kp: BoxKeyPair
        if secret_key is not None:
            kp = keypair_from_secret(secret_key)
        else:
            kp = generate_keypair()

        self.public_key: bytes = kp.public_key
        self.secret_key: bytes = kp.secret_key
        self.agent_id: str = f"agent_{to_hex(kp.public_key)[:12]}"

        # Ed25519 signing keypair derived from x25519 secret
        signing_kp = signing_keypair_from_seed(kp.secret_key)
        self.signing_public_key: bytes = signing_kp.public_key
        self._signing_secret_key: bytes = signing_kp.secret_key

        self._agent_name = agent_name
        self._human_pubkey: Optional[bytes] = None
        self._human_pubkey_hex: Optional[str] = None
        self._relay_url: Optional[str] = None
        self._human_wallet: Optional[str] = None
        self._mode: str = "encrypted"
        self._chain_family: Optional[str] = None
        self._chain_network: Optional[str] = None

    @property
    def paired(self) -> bool:
        """Whether this agent has been paired with a human."""
        return self._human_pubkey is not None

    def pair(self, qr_data: str) -> PairingData:
        """Parse QR / pairing JSON and store the human's pubkey + relay URL."""
        try:
            raw = json.loads(qr_data)
        except (json.JSONDecodeError, TypeError) as exc:
            raise PairingError(f"invalid pairing JSON: {exc}") from exc

        version = raw.get("version")
        if version != 1:
            raise PairingError(f"unsupported pairing version: {version}")

        pubkey = raw.get("pubkey")
        relay = raw.get("relay")
        if not pubkey or not relay:
            raise PairingError("invalid pairing data: missing pubkey or relay")

        self._human_pubkey = from_hex(pubkey)
        self._human_pubkey_hex = pubkey
        self._relay_url = relay
        self._human_wallet = raw.get("wallet") or None
        self._mode = raw.get("mode") or "encrypted"
        self._chain_family = raw.get("chain_family") or None
        self._chain_network = raw.get("chain_network") or None

        return PairingData(
            version=version,
            pubkey=pubkey,
            relay=relay,
            wallet=raw.get("wallet", ""),
            mode=raw.get("mode"),
            chain_family=raw.get("chain_family"),
            chain_network=raw.get("chain_network"),
        )

    async def request_tx(self, options: RequestTxOptions) -> str:
        """Send a tx request to the paired human and wait for approval.

        Returns the tx hash on approval.
        Raises InvalidTxError (before anything is sent), TxRejectedError,
        TxTimeoutError, TxError, or RelayError.
        """
        if not self.paired:
            raise NotPairedError()

        # a bitcoin or chia pairing takes transfers only: its wallet can't sign an evm tx
        if self._chain_family not in (None, "evm"):
            raise InvalidTxError(
                "chain_family", f"this pairing is for {self._chain_family}: use request_transfer for bitcoin or chia"
            )

        # reject malformed requests before anything reaches the relay
        chain_id, transaction = validate_tx(options.chain_id, options.transaction)

        request_id = _new_request_id()

        tx_request = TxRequest(
            request_id=request_id,
            agent_id=self.agent_id,
            timestamp=_iso_now(),
            chain_id=chain_id,
            transaction=transaction,
            signature="",  # filled after signing
            context=options.context,
        )

        # sign the request (signature field empty during signing, then filled)
        sig_payload = json.dumps(_tx_request_to_dict(tx_request), separators=(",", ":"))
        tx_request.signature = sign_message(sig_payload, self._signing_secret_key)
        plaintext = json.dumps(_tx_request_to_dict(tx_request), separators=(",", ":"))

        # managed mode: relay gets plaintext tx params so it can simulate (same object as src/client.ts)
        simulate: Optional[Dict[str, Any]] = None
        if self._mode == "managed":
            simulate = {
                "from": self._human_wallet or "",
                "to": transaction.to,
                "value": transaction.value,
                "data": transaction.data,
                "chainId": chain_id,
            }

        return await self._send(request_id, plaintext, options.timeout_ms, simulate)

    async def request_transfer(self, options: RequestTransferOptions) -> str:
        """Send a bitcoin / chia transfer request to the paired human and wait for approval.

        The human's wallet builds, signs and broadcasts the transfer. Needs a bitcoin or
        chia pairing. Returns the transaction id on approval.
        Raises InvalidTxError (before anything is sent), TxRejectedError,
        TxTimeoutError, TxError, or RelayError.
        """
        if not self.paired:
            raise NotPairedError()

        # reject malformed requests before anything reaches the relay
        chain_family, chain_network, transfer = validate_transfer(
            self._chain_family, options.chain_network, options.transfer
        )
        if self._chain_network and self._chain_network != chain_network:
            raise InvalidTxError(
                "chain_network", f'this pairing is for {chain_family} {self._chain_network}, got "{chain_network}"'
            )

        request_id = _new_request_id()
        request = TransferRequest(
            request_id=request_id,
            agent_id=self.agent_id,
            timestamp=_iso_now(),
            chain_family=chain_family,
            chain_network=chain_network,
            transfer=transfer,
            signature="",  # filled after signing
            context=options.context,
        )
        sig_payload = json.dumps(_transfer_request_to_dict(request), separators=(",", ":"))
        request.signature = sign_message(sig_payload, self._signing_secret_key)
        plaintext = json.dumps(_transfer_request_to_dict(request), separators=(",", ":"))

        # the relay simulator is evm-only: no simulate object for transfers, even on a managed pairing
        return await self._send(request_id, plaintext, options.timeout_ms, None)

    async def _send(
        self,
        request_id: str,
        plaintext: str,
        timeout_ms: Optional[int],
        simulate: Optional[Dict[str, Any]],
    ) -> str:
        """Deliver a signed request to the paired human and wait for the answer, mapping failures to SDK errors."""
        human_pubkey, room, relay_url = self._human_pubkey, self._human_pubkey_hex, self._relay_url
        if human_pubkey is None or room is None or relay_url is None:
            raise NotPairedError()
        timeout_ms = timeout_ms or _DEFAULT_TIMEOUT_MS

        try:
            return await asyncio.wait_for(
                self._ws_request(
                    relay_url=relay_url,
                    room=room,
                    human_pubkey=human_pubkey,
                    agent_pubkey_hex=to_hex(self.public_key),
                    signing_pubkey_hex=to_hex(self.signing_public_key),
                    plaintext=plaintext,
                    request_id=request_id,
                    simulate=simulate,
                ),
                timeout=timeout_ms / 1000.0,
            )
        except asyncio.TimeoutError:
            raise TxTimeoutError(request_id, timeout_ms)
        except (TxRejectedError, TxError, TxTimeoutError, NotPairedError, RelayError):
            raise
        except websockets.exceptions.ConnectionClosed as exc:
            # dropped after the handshake: the relay was reachable, so no sandbox hint (matches src/client.ts)
            raise RelayError(f"relay connection error: {exc}") from exc
        except Exception as exc:
            raise RelayError(f"relay connection error: could not reach {relay_url} ({exc}; {_UNREACHABLE_HINT})") from exc

    async def _ws_request(
        self,
        *,
        relay_url: str,
        room: str,
        human_pubkey: bytes,
        agent_pubkey_hex: str,
        signing_pubkey_hex: str,
        plaintext: str,
        request_id: str,
        simulate: Optional[Dict[str, Any]],
    ) -> str:
        """Open WS, join room, send encrypted request, wait for response."""
        async with websockets.asyncio.client.connect(relay_url) as ws:
            # join the human's room
            await ws.send(json.dumps({"type": "join", "room": room}))

            async for raw_msg in ws:
                msg = json.loads(raw_msg)

                if msg.get("type") == "joined":
                    # room joined — send the encrypted request
                    ciphertext = encrypt_message(
                        plaintext, human_pubkey, self.secret_key
                    )
                    envelope = AgentEnvelope(
                        sender_pubkey=agent_pubkey_hex,
                        ciphertext=ciphertext,
                        signing_pubkey=signing_pubkey_hex,
                    )
                    ws_msg: Dict[str, Any] = {
                        "type": "message",
                        "room": room,
                        "payload": json.dumps(
                            {
                                "sender_pubkey": envelope.sender_pubkey,
                                "ciphertext": envelope.ciphertext,
                                "signing_pubkey": envelope.signing_pubkey,
                            }
                        ),
                    }
                    if simulate is not None:
                        ws_msg["simulate"] = simulate
                    await ws.send(json.dumps(ws_msg))
                    continue

                if msg.get("type") == "message":
                    try:
                        env_raw = json.loads(msg["payload"])
                        # only the paired human may answer (room id == human pubkey hex)
                        if str(env_raw.get("sender_pubkey", "")).lower() != room.lower():
                            continue
                        plaintext_resp = decrypt_message(
                            env_raw["ciphertext"],
                            human_pubkey,
                            self.secret_key,
                        )
                        if plaintext_resp is None:
                            continue  # not for us or decryption failed

                        response_raw = json.loads(plaintext_resp)
                        response = TxResponse(
                            request_id=response_raw["request_id"],
                            status=response_raw["status"],
                            tx_hash=response_raw.get("tx_hash"),
                            error=response_raw.get("error"),
                        )

                        if response.request_id != request_id:
                            continue  # not our response

                        if response.status == "approved" and response.tx_hash:
                            return response.tx_hash
                        elif response.status == "rejected":
                            raise TxRejectedError(request_id)
                        elif response.error:
                            raise TxError(request_id, response.error)
                        else:
                            raise TxError(
                                request_id,
                                f'unexpected response status "{response.status}"',
                            )
                    except (json.JSONDecodeError, KeyError):
                        continue  # ignore malformed messages

                if msg.get("type") == "error":
                    raise RelayError(f"relay error: {msg.get('message', 'unknown')}")

            # ws closed without response
            raise RelayError("relay connection closed unexpectedly")


def _new_request_id() -> str:
    return f"req_{int(time.time() * 1000)}_{_random_suffix()}"


def _random_suffix() -> str:
    """Generate a short random suffix for request IDs."""
    import random
    import string

    return "".join(random.choices(string.ascii_lowercase + string.digits, k=6))


def _iso_now() -> str:
    """Current time as ISO 8601 string."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
