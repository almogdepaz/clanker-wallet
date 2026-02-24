"""Integration tests for ClankerWallet — mirrors sdk/src/client.test.ts.

Spawns a relay server subprocess, simulates the human side via websockets,
and tests full e2e flows (approve, reject, timeout, encryption opacity).
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import time
from typing import Any, Callable, Dict, Generator, List, Optional, Tuple

import pytest
import websockets.asyncio.client

from clanker_wallet import ClankerWallet
from clanker_wallet.crypto import (
    BoxKeyPair,
    decrypt_message,
    encrypt_message,
    from_hex,
    generate_keypair,
    to_hex,
)
from clanker_wallet.errors import (
    NotPairedError,
    PairingError,
    TxRejectedError,
    TxTimeoutError,
)
from clanker_wallet.types import (
    RequestTxOptions,
    Transaction,
    TxContext,
)

PORT = 9878
RELAY_URL = f"ws://localhost:{PORT}/ws"
RELAY_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "relay"))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def relay_server() -> Generator[subprocess.Popen[bytes], None, None]:
    """Start relay server subprocess for the test module."""
    proc = subprocess.Popen(
        ["bun", "src/server.ts"],
        cwd=RELAY_DIR,
        env={**os.environ, "PORT": str(PORT)},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    # wait for server to be ready
    for _ in range(40):
        try:
            import urllib.request

            resp = urllib.request.urlopen(f"http://localhost:{PORT}/health", timeout=1)
            if resp.status == 200:
                break
        except Exception:
            pass
        time.sleep(0.25)
    else:
        proc.kill()
        raise RuntimeError("relay server failed to start")

    yield proc

    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


# ---------------------------------------------------------------------------
# Human simulation helper
# ---------------------------------------------------------------------------


async def simulate_human(
    human_keypair: BoxKeyPair,
    relay_url: str,
    respond: Callable[[Dict[str, Any], str], Optional[Dict[str, Any]]],
) -> Tuple[Any, List[Dict[str, Any]], asyncio.Task[None]]:
    """Connect as human, decrypt agent messages, send responses.

    Returns (ws, received_requests, listener_task).
    """
    human_pubkey_hex = to_hex(human_keypair.public_key)
    ws = await websockets.asyncio.client.connect(relay_url)

    # join room
    await ws.send(json.dumps({"type": "join", "room": human_pubkey_hex}))
    ack = json.loads(await ws.recv())
    assert ack["type"] == "joined"

    received: List[Dict[str, Any]] = []

    async def listener() -> None:
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg.get("type") != "message":
                    continue

                try:
                    envelope = json.loads(msg["payload"])
                    plaintext = decrypt_message(
                        envelope["ciphertext"],
                        from_hex(envelope["sender_pubkey"]),
                        human_keypair.secret_key,
                    )
                    if plaintext is None:
                        continue

                    tx_req = json.loads(plaintext)
                    received.append(tx_req)

                    response = respond(tx_req, envelope["sender_pubkey"])
                    if response is None:
                        continue

                    # encrypt and send back
                    ciphertext = encrypt_message(
                        json.dumps(response),
                        from_hex(envelope["sender_pubkey"]),
                        human_keypair.secret_key,
                    )
                    resp_envelope = {
                        "sender_pubkey": human_pubkey_hex,
                        "ciphertext": ciphertext,
                    }
                    await ws.send(
                        json.dumps(
                            {
                                "type": "message",
                                "room": human_pubkey_hex,
                                "payload": json.dumps(resp_envelope),
                            }
                        )
                    )
                except (json.JSONDecodeError, KeyError):
                    continue
        except websockets.exceptions.ConnectionClosed:
            pass

    task = asyncio.create_task(listener())
    return ws, received, task


# ---------------------------------------------------------------------------
# Unit tests (no relay needed)
# ---------------------------------------------------------------------------


class TestClankerWalletUnit:
    def test_generates_unique_agent_id(self) -> None:
        w1 = ClankerWallet()
        w2 = ClankerWallet()
        assert w1.agent_id.startswith("agent_")
        assert len(w1.agent_id) == 18  # "agent_" + 12 hex chars
        assert w1.agent_id != w2.agent_id

    def test_restores_keypair_from_secret(self) -> None:
        w1 = ClankerWallet()
        w2 = ClankerWallet(secret_key=w1.secret_key)
        assert to_hex(w2.public_key) == to_hex(w1.public_key)
        assert w2.agent_id == w1.agent_id

    def test_pair_parses_qr_data(self) -> None:
        wallet = ClankerWallet()
        assert wallet.paired is False

        qr_data = json.dumps(
            {
                "version": 1,
                "pubkey": "aabbccdd",
                "relay": RELAY_URL,
                "wallet": "0x1234",
            }
        )
        data = wallet.pair(qr_data)

        assert wallet.paired is True
        assert data.pubkey == "aabbccdd"
        assert data.relay == RELAY_URL
        assert data.wallet == "0x1234"

    def test_pair_rejects_invalid_version(self) -> None:
        wallet = ClankerWallet()
        with pytest.raises(PairingError, match="unsupported pairing version"):
            wallet.pair(json.dumps({"version": 99, "pubkey": "aa", "relay": "ws://x"}))

    def test_pair_rejects_missing_fields(self) -> None:
        wallet = ClankerWallet()
        with pytest.raises(PairingError, match="missing pubkey or relay"):
            wallet.pair(json.dumps({"version": 1}))

    async def test_request_tx_throws_if_not_paired(self) -> None:
        wallet = ClankerWallet()
        with pytest.raises(NotPairedError, match="not paired"):
            await wallet.request_tx(
                RequestTxOptions(
                    chain_id=1,
                    transaction=Transaction(to="0x0", value="0", data="0x"),
                )
            )


# ---------------------------------------------------------------------------
# Integration tests (relay required)
# ---------------------------------------------------------------------------


class TestClankerWalletIntegration:
    async def test_full_flow_approve(self, relay_server: Any) -> None:
        """Agent sends tx request, human approves."""
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        def respond(req: Dict[str, Any], _agent_pub: str) -> Dict[str, Any]:
            return {
                "request_id": req["request_id"],
                "status": "approved",
                "tx_hash": "0xdeadbeef1234",
            }

        ws, received, listener_task = await simulate_human(human_kp, RELAY_URL, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {
                        "version": 1,
                        "pubkey": human_pubkey_hex,
                        "relay": RELAY_URL,
                        "wallet": "0xhuman",
                    }
                )
            )

            tx_hash = await agent.request_tx(
                RequestTxOptions(
                    chain_id=11155111,
                    transaction=Transaction(
                        to="0xrecipient",
                        value="1000000000000000",
                        data="0x",
                    ),
                    context=TxContext(reason="test transfer", urgency="normal"),
                    timeout_ms=10000,
                )
            )

            assert tx_hash == "0xdeadbeef1234"
            # give listener a moment to process
            await asyncio.sleep(0.2)
            assert len(received) == 1
            assert received[0]["chain_id"] == 11155111
            assert received[0]["transaction"]["to"] == "0xrecipient"
            assert received[0]["context"]["reason"] == "test transfer"
            assert received[0]["agent_id"] == agent.agent_id
        finally:
            listener_task.cancel()
            await ws.close()

    async def test_full_flow_reject(self, relay_server: Any) -> None:
        """Agent sends tx request, human rejects."""
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        def respond(req: Dict[str, Any], _agent_pub: str) -> Dict[str, Any]:
            return {
                "request_id": req["request_id"],
                "status": "rejected",
            }

        ws, _received, listener_task = await simulate_human(human_kp, RELAY_URL, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {
                        "version": 1,
                        "pubkey": human_pubkey_hex,
                        "relay": RELAY_URL,
                        "wallet": "0xhuman",
                    }
                )
            )

            with pytest.raises(TxRejectedError, match="rejected by human"):
                await agent.request_tx(
                    RequestTxOptions(
                        chain_id=1,
                        transaction=Transaction(to="0xrecipient", value="0", data="0x"),
                        timeout_ms=10000,
                    )
                )
        finally:
            listener_task.cancel()
            await ws.close()

    async def test_request_tx_timeout(self, relay_server: Any) -> None:
        """Agent times out if human never responds."""
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        # human joins but never responds
        def respond(_req: Dict[str, Any], _agent_pub: str) -> None:
            return None

        ws, _received, listener_task = await simulate_human(human_kp, RELAY_URL, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {
                        "version": 1,
                        "pubkey": human_pubkey_hex,
                        "relay": RELAY_URL,
                        "wallet": "0xhuman",
                    }
                )
            )

            with pytest.raises(TxTimeoutError, match="timed out"):
                await agent.request_tx(
                    RequestTxOptions(
                        chain_id=1,
                        transaction=Transaction(to="0x0", value="0", data="0x"),
                        timeout_ms=1500,
                    )
                )
        finally:
            listener_task.cancel()
            await ws.close()

    async def test_e2e_encryption_opacity(self, relay_server: Any) -> None:
        """Relay only sees ciphertext, never plaintext tx details."""
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        # spy on relay traffic
        spy_ws = await websockets.asyncio.client.connect(RELAY_URL)
        await spy_ws.send(json.dumps({"type": "join", "room": human_pubkey_hex}))
        spy_ack = json.loads(await spy_ws.recv())
        assert spy_ack["type"] == "joined"

        relay_messages: List[Dict[str, Any]] = []

        async def spy_listener() -> None:
            try:
                async for raw in spy_ws:
                    try:
                        relay_messages.append(json.loads(raw))
                    except json.JSONDecodeError:
                        pass
            except websockets.exceptions.ConnectionClosed:
                pass

        spy_task = asyncio.create_task(spy_listener())

        def respond(req: Dict[str, Any], _agent_pub: str) -> Dict[str, Any]:
            return {
                "request_id": req["request_id"],
                "status": "approved",
                "tx_hash": "0xabc",
            }

        ws, _received, listener_task = await simulate_human(human_kp, RELAY_URL, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {
                        "version": 1,
                        "pubkey": human_pubkey_hex,
                        "relay": RELAY_URL,
                        "wallet": "0xhuman",
                    }
                )
            )

            await agent.request_tx(
                RequestTxOptions(
                    chain_id=1,
                    transaction=Transaction(
                        to="0xsecret",
                        value="999",
                        data="0xdeadbeef",
                    ),
                    timeout_ms=10000,
                )
            )

            await asyncio.sleep(0.3)

            # relay messages should contain ciphertext, NOT plaintext
            payloads = [
                m["payload"]
                for m in relay_messages
                if m.get("type") == "message"
            ]

            assert len(payloads) > 0, "expected relay messages"

            for payload in payloads:
                assert "0xsecret" not in payload
                assert "0xdeadbeef" not in payload
                # should be AgentEnvelope with ciphertext
                env = json.loads(payload)
                assert env.get("sender_pubkey")
                assert env.get("ciphertext")
        finally:
            listener_task.cancel()
            spy_task.cancel()
            await ws.close()
            await spy_ws.close()
