"""ClankerWallet client — pair with a human, request tx approvals.

Mirrors sdk/src/client.ts.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Optional

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
    RequestTxOptions,
    TxRequest,
    TxResponse,
    _tx_request_to_dict,
)

_DEFAULT_TIMEOUT_MS = 3_600_000  # 1 hour


class ClankerWallet:
    """E2E encrypted wallet client for AI agents.

    Usage::

        wallet = ClankerWallet()
        wallet.pair(qr_json)
        tx_hash = await wallet.request_tx(RequestTxOptions(
            chain_id=1,
            transaction=Transaction(to="0x...", value="0", data="0x"),
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

        return PairingData(
            version=version,
            pubkey=pubkey,
            relay=relay,
            wallet=raw.get("wallet", ""),
        )

    async def request_tx(self, options: RequestTxOptions) -> str:
        """Send a tx request to the paired human and wait for approval.

        Returns the tx hash on approval.
        Raises TxRejectedError, TxTimeoutError, TxError, or RelayError.
        """
        if (
            self._human_pubkey is None
            or self._human_pubkey_hex is None
            or self._relay_url is None
        ):
            raise NotPairedError()

        timeout_ms = options.timeout_ms or _DEFAULT_TIMEOUT_MS
        request_id = f"req_{int(time.time() * 1000)}_{_random_suffix()}"

        tx_request = TxRequest(
            request_id=request_id,
            agent_id=self.agent_id,
            timestamp=_iso_now(),
            chain_id=options.chain_id,
            transaction=options.transaction,
            signature="",  # filled after signing
            context=options.context,
        )

        # sign the request (signature field empty during signing, then filled)
        sig_payload = json.dumps(_tx_request_to_dict(tx_request), separators=(",", ":"))
        tx_request.signature = sign_message(sig_payload, self._signing_secret_key)

        human_pubkey = self._human_pubkey
        human_pubkey_hex = self._human_pubkey_hex
        relay_url = self._relay_url
        agent_pubkey_hex = to_hex(self.public_key)
        signing_pubkey_hex = to_hex(self.signing_public_key)

        timeout_s = timeout_ms / 1000.0

        try:
            return await asyncio.wait_for(
                self._ws_request(
                    relay_url=relay_url,
                    room=human_pubkey_hex,
                    human_pubkey=human_pubkey,
                    agent_pubkey_hex=agent_pubkey_hex,
                    signing_pubkey_hex=signing_pubkey_hex,
                    tx_request=tx_request,
                    request_id=request_id,
                ),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            raise TxTimeoutError(request_id, timeout_ms)
        except (TxRejectedError, TxError, TxTimeoutError, NotPairedError):
            raise
        except Exception as exc:
            raise RelayError(f"relay connection error: {exc}") from exc

    async def _ws_request(
        self,
        *,
        relay_url: str,
        room: str,
        human_pubkey: bytes,
        agent_pubkey_hex: str,
        signing_pubkey_hex: str,
        tx_request: TxRequest,
        request_id: str,
    ) -> str:
        """Open WS, join room, send encrypted request, wait for response."""
        async with websockets.asyncio.client.connect(relay_url) as ws:
            # join the human's room
            await ws.send(json.dumps({"type": "join", "room": room}))

            async for raw_msg in ws:
                msg = json.loads(raw_msg)

                if msg.get("type") == "joined":
                    # room joined — send the encrypted tx request
                    plaintext = json.dumps(
                        _tx_request_to_dict(tx_request), separators=(",", ":")
                    )
                    ciphertext = encrypt_message(
                        plaintext, human_pubkey, self.secret_key
                    )
                    envelope = AgentEnvelope(
                        sender_pubkey=agent_pubkey_hex,
                        ciphertext=ciphertext,
                        signing_pubkey=signing_pubkey_hex,
                    )
                    await ws.send(
                        json.dumps(
                            {
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
                        )
                    )
                    continue

                if msg.get("type") == "message":
                    try:
                        env_raw = json.loads(msg["payload"])
                        plaintext_resp = decrypt_message(
                            env_raw["ciphertext"],
                            from_hex(env_raw["sender_pubkey"]),
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


def _random_suffix() -> str:
    """Generate a short random suffix for request IDs."""
    import random
    import string

    return "".join(random.choices(string.ascii_lowercase + string.digits, k=6))


def _iso_now() -> str:
    """Current time as ISO 8601 string."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
