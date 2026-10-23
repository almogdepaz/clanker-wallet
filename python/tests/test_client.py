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
import websockets.asyncio.server

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
    InvalidTxError,
    NotPairedError,
    PairingError,
    RelayError,
    TxRejectedError,
    TxTimeoutError,
)
from clanker_wallet import client as client_module
from clanker_wallet.crypto import keypair_from_secret, verify_signature
from clanker_wallet.types import (
    RequestTransferOptions,
    RequestTxOptions,
    Transaction,
    Transfer,
    TxContext,
)

PORT = 9878
RELAY_URL = f"ws://localhost:{PORT}/ws"
RELAY_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "relay"))

RECIPIENT = "0x1111111111111111111111111111111111111111"
TO = "0x2222222222222222222222222222222222222222"
SECRET_TO = "0x5ec2e75ec2e75ec2e75ec2e75ec2e75ec2e75ec2"


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


@pytest.fixture
async def logging_relay() -> Any:
    """Minimal in-process relay (join room, broadcast to the other members).

    Yields (ws url, every message the relay received, as sent).
    Self-contained: no external relay checkout needed.
    """
    rooms: Dict[str, set[Any]] = {}
    log: List[Dict[str, Any]] = []

    async def handler(conn: Any) -> None:
        room: Optional[str] = None
        try:
            async for raw in conn:
                msg = json.loads(raw)
                log.append(msg)
                if msg.get("type") == "join":
                    room = msg["room"]
                    rooms.setdefault(room, set()).add(conn)
                    await conn.send(json.dumps({"type": "joined", "room": room}))
                elif msg.get("type") == "message" and room and msg.get("room") == room:
                    out = json.dumps({"type": "message", "room": room, "payload": msg["payload"]})
                    for peer in list(rooms.get(room, ())):
                        if peer is not conn:
                            await peer.send(out)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if room:
                rooms.get(room, set()).discard(conn)

    async with websockets.asyncio.server.serve(handler, "127.0.0.1", 0) as server:
        port = next(iter(server.sockets)).getsockname()[1]
        yield f"ws://127.0.0.1:{port}/ws", log


@pytest.fixture
def inprocess_relay(logging_relay: Tuple[str, List[Dict[str, Any]]]) -> str:
    return logging_relay[0]


async def post_response(
    ws: Any,
    sender: BoxKeyPair,
    room: str,
    agent_pubkey_hex: str,
    response: Dict[str, Any],
) -> None:
    """Send an encrypted TxResponse into the room from `sender`'s keypair."""
    envelope = {
        "sender_pubkey": to_hex(sender.public_key),
        "ciphertext": encrypt_message(
            json.dumps(response), from_hex(agent_pubkey_hex), sender.secret_key
        ),
    }
    await ws.send(json.dumps({"type": "message", "room": room, "payload": json.dumps(envelope)}))


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
                    transaction=Transaction(to=TO, value="0", data="0x"),
                )
            )


# ---------------------------------------------------------------------------
# Integration tests (relay required)
# ---------------------------------------------------------------------------


class TestClankerWalletIntegration:
    async def test_ignores_responses_not_from_paired_human(self, inprocess_relay: str) -> None:
        """A forged approval encrypted by a third keypair must not resolve the request."""
        relay_url = inprocess_relay
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)
        attacker_kp = generate_keypair()

        attacker_ws = await websockets.asyncio.client.connect(relay_url)
        await attacker_ws.send(json.dumps({"type": "join", "room": human_pubkey_hex}))
        assert json.loads(await attacker_ws.recv())["type"] == "joined"

        pending: List[asyncio.Task[None]] = []

        def respond(req: Dict[str, Any], agent_pub: str) -> None:
            async def answer() -> None:
                await post_response(
                    attacker_ws,
                    attacker_kp,
                    human_pubkey_hex,
                    agent_pub,
                    {"request_id": req["request_id"], "status": "approved", "tx_hash": "0xforged"},
                )
                await asyncio.sleep(0.3)
                await post_response(
                    ws,
                    human_kp,
                    human_pubkey_hex,
                    agent_pub,
                    {"request_id": req["request_id"], "status": "approved", "tx_hash": "0xgenuine"},
                )

            pending.append(asyncio.create_task(answer()))
            return None

        ws, _received, listener_task = await simulate_human(human_kp, relay_url, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {"version": 1, "pubkey": human_pubkey_hex, "relay": relay_url, "wallet": "0xhuman"}
                )
            )
            tx_hash = await agent.request_tx(
                RequestTxOptions(
                    chain_id=1,
                    transaction=Transaction(to=RECIPIENT, value="1", data="0x"),
                    timeout_ms=10000,
                )
            )
            assert tx_hash == "0xgenuine"
        finally:
            for t in pending:
                t.cancel()
            listener_task.cancel()
            await ws.close()
            await attacker_ws.close()

    async def test_full_flow_approve(self, inprocess_relay: str) -> None:
        """Agent sends tx request, human approves."""
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        def respond(req: Dict[str, Any], _agent_pub: str) -> Dict[str, Any]:
            return {
                "request_id": req["request_id"],
                "status": "approved",
                "tx_hash": "0xdeadbeef1234",
            }

        ws, received, listener_task = await simulate_human(human_kp, inprocess_relay, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {
                        "version": 1,
                        "pubkey": human_pubkey_hex,
                        "relay": inprocess_relay,
                        "wallet": "0xhuman",
                    }
                )
            )

            tx_hash = await agent.request_tx(
                RequestTxOptions(
                    chain_id=11155111,
                    transaction=Transaction(
                        to=RECIPIENT,
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
            assert received[0]["transaction"]["to"] == RECIPIENT
            assert received[0]["context"]["reason"] == "test transfer"
            assert received[0]["agent_id"] == agent.agent_id
        finally:
            listener_task.cancel()
            await ws.close()

    async def test_full_flow_reject(self, inprocess_relay: str) -> None:
        """Agent sends tx request, human rejects."""
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        def respond(req: Dict[str, Any], _agent_pub: str) -> Dict[str, Any]:
            return {
                "request_id": req["request_id"],
                "status": "rejected",
            }

        ws, _received, listener_task = await simulate_human(human_kp, inprocess_relay, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {
                        "version": 1,
                        "pubkey": human_pubkey_hex,
                        "relay": inprocess_relay,
                        "wallet": "0xhuman",
                    }
                )
            )

            with pytest.raises(TxRejectedError, match="rejected by human"):
                await agent.request_tx(
                    RequestTxOptions(
                        chain_id=1,
                        transaction=Transaction(to=RECIPIENT, value="0", data="0x"),
                        timeout_ms=10000,
                    )
                )
        finally:
            listener_task.cancel()
            await ws.close()

    async def test_request_tx_timeout(self, inprocess_relay: str) -> None:
        """Agent times out if human never responds."""
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        # human joins but never responds
        def respond(_req: Dict[str, Any], _agent_pub: str) -> None:
            return None

        ws, _received, listener_task = await simulate_human(human_kp, inprocess_relay, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {
                        "version": 1,
                        "pubkey": human_pubkey_hex,
                        "relay": inprocess_relay,
                        "wallet": "0xhuman",
                    }
                )
            )

            with pytest.raises(TxTimeoutError, match="timed out"):
                await agent.request_tx(
                    RequestTxOptions(
                        chain_id=1,
                        transaction=Transaction(to=TO, value="0", data="0x"),
                        timeout_ms=1500,
                    )
                )
        finally:
            listener_task.cancel()
            await ws.close()

    async def test_e2e_encryption_opacity(self, inprocess_relay: str) -> None:
        """Relay only sees ciphertext, never plaintext tx details."""
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        # spy on relay traffic
        spy_ws = await websockets.asyncio.client.connect(inprocess_relay)
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

        ws, _received, listener_task = await simulate_human(human_kp, inprocess_relay, respond)

        try:
            agent = ClankerWallet()
            agent.pair(
                json.dumps(
                    {
                        "version": 1,
                        "pubkey": human_pubkey_hex,
                        "relay": inprocess_relay,
                        "wallet": "0xhuman",
                    }
                )
            )

            await agent.request_tx(
                RequestTxOptions(
                    chain_id=1,
                    transaction=Transaction(
                        to=SECRET_TO,
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
                assert SECRET_TO not in payload
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


# ---------------------------------------------------------------------------
# Validation + managed-mode simulate (mirrors src/client.test.ts)
# ---------------------------------------------------------------------------


def _pair(agent: ClankerWallet, relay_url: str, human_pubkey_hex: str, mode: Optional[str]) -> None:
    agent.pair(
        json.dumps(
            {"version": 1, "pubkey": human_pubkey_hex, "relay": relay_url, "wallet": RECIPIENT, "mode": mode}
        )
    )


class TestRequestTxValidation:
    def test_pair_returns_mode(self) -> None:
        data = ClankerWallet().pair(
            json.dumps({"version": 1, "pubkey": "aa", "relay": "ws://x", "mode": "managed"})
        )
        assert data.mode == "managed"

    @pytest.mark.parametrize(
        "tx,field",
        [
            # the two literal requests from the prod e2e report
            (Transaction(to="0x...", value="0"), "to"),
            (
                Transaction(
                    to="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                    value="0",
                    data="0xa9059cbb000000000000000000000000RecipientAddr00000000000000000000000000000000000000000000000000000000000f4240",
                ),
                "data",
            ),
        ],
    )
    async def test_rejects_before_sending(
        self, logging_relay: Tuple[str, List[Dict[str, Any]]], tx: Transaction, field: str
    ) -> None:
        relay_url, log = logging_relay
        human_pubkey_hex = to_hex(generate_keypair().public_key)
        agent = ClankerWallet()
        _pair(agent, relay_url, human_pubkey_hex, "managed")

        with pytest.raises(InvalidTxError) as exc:
            await agent.request_tx(RequestTxOptions(chain_id=1, transaction=tx, timeout_ms=2000))
        assert exc.value.field == field
        assert log == []

    async def test_unreachable_relay_names_the_url(self) -> None:
        # nothing listens on port 1
        dead_relay = "ws://127.0.0.1:1"
        agent = ClankerWallet()
        _pair(agent, dead_relay, to_hex(generate_keypair().public_key), "encrypted")

        with pytest.raises(RelayError) as exc:
            await agent.request_tx(
                RequestTxOptions(chain_id=84532, transaction=Transaction(to=TO, value=1), timeout_ms=5000)
            )
        assert dead_relay in str(exc.value)

    @pytest.mark.parametrize("after_join", ["error_frame", "clean_close", "drop"])
    async def test_failure_after_connect_is_not_called_unreachable(self, after_join: str) -> None:
        """the sandbox/firewall hint is for connect failures only; a relay that answered was reachable (matches src/client.ts)."""

        async def handler(conn: Any) -> None:
            await conn.recv()  # join
            await conn.send(json.dumps({"type": "joined"}))
            await conn.recv()  # the request
            if after_join == "error_frame":
                await conn.send(json.dumps({"type": "error", "message": "rate limited"}))
                await conn.wait_closed()
            elif after_join == "clean_close":
                await conn.close()
            else:
                conn.transport.abort()

        async with websockets.asyncio.server.serve(handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            agent = ClankerWallet()
            _pair(agent, f"ws://127.0.0.1:{port}", to_hex(generate_keypair().public_key), "encrypted")

            with pytest.raises(RelayError) as exc:
                await agent.request_tx(
                    RequestTxOptions(chain_id=84532, transaction=Transaction(to=TO, value=1), timeout_ms=5000)
                )
        assert "could not reach" not in str(exc.value)
        assert "sandbox" not in str(exc.value)
        if after_join == "error_frame":
            assert "rate limited" in str(exc.value)

    @pytest.mark.parametrize("mode", ["managed", "encrypted"])
    async def test_simulate_matches_js_sdk(
        self, logging_relay: Tuple[str, List[Dict[str, Any]]], mode: str
    ) -> None:
        """managed mode sends the normalized tx as `simulate`, the same object src/client.ts sends."""
        relay_url, log = logging_relay
        human_kp = generate_keypair()
        human_pubkey_hex = to_hex(human_kp.public_key)

        def respond(req: Dict[str, Any], _agent_pub: str) -> Dict[str, Any]:
            return {"request_id": req["request_id"], "status": "approved", "tx_hash": "0xabc"}

        ws, received, listener_task = await simulate_human(human_kp, relay_url, respond)
        try:
            agent = ClankerWallet()
            _pair(agent, relay_url, human_pubkey_hex, mode)
            await agent.request_tx(
                RequestTxOptions(
                    chain_id=84532,
                    transaction=Transaction(to=TO, value=10**18),
                    timeout_ms=10000,
                )
            )
            sent = [m for m in log if m.get("type") == "message"]
            agent_msg = next(m for m in sent if json.loads(m["payload"]).get("signing_pubkey"))
            if mode == "managed":
                assert agent_msg["simulate"] == {
                    "from": RECIPIENT,
                    "to": TO,
                    "value": "1000000000000000000",
                    "data": "0x",
                    "chainId": 84532,
                }
            else:
                assert "simulate" not in agent_msg
            assert received[0]["transaction"] == {"to": TO, "value": "1000000000000000000", "data": "0x"}
        finally:
            listener_task.cancel()
            await ws.close()


# ---------------------------------------------------------------------------
# Wire format: evm requests pinned byte for byte; bitcoin / chia transfers (mirrors src/wire.test.ts)
# ---------------------------------------------------------------------------

AGENT_SECRET = bytes([7]) * 32
FROZEN_REQUEST_ID = "req_1767323045678_4fzzzx"
FROZEN_NOW = "2026-01-02T03:04:05.678Z"
TXCH = "txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg"
BTC_TEST = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"

# what 0.4.2 sends for this request (python keeps context after signature); must not change
EVM_PLAINTEXT = (
    '{"request_id":"req_1767323045678_4fzzzx","agent_id":"agent_13be4feaeaf2","timestamp":"2026-01-02T03:04:05.678Z",'
    '"chain_id":84532,"transaction":{"to":"0x2222222222222222222222222222222222222222","value":"5","data":"0xabcd"},'
    '"signature":"6kVLWE36IfpETdlbeRk0Rg9sDYrwrkSw2BlCp8L1b9Ptq2ib1GOlxqNsLbcHAwsz4+tCEybXuNE1CXbrofKmAw==",'
    '"context":{"reason":"pay","urgency":"low","expected_outcome":"paid"}}'
)


@pytest.fixture
def frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fix the request id and timestamp so the signed request is deterministic."""
    monkeypatch.setattr(client_module, "time", type("FrozenTime", (), {"time": staticmethod(lambda: 1767323045.678)}))
    monkeypatch.setattr(client_module, "_random_suffix", lambda: "4fzzzx")
    monkeypatch.setattr(client_module, "_iso_now", lambda: FROZEN_NOW)


async def _capture(
    logging_relay: Tuple[str, List[Dict[str, Any]]],
    pairing: Dict[str, Any],
    send: Callable[[ClankerWallet], Any],
) -> Tuple[str, Dict[str, Any]]:
    """Pair a fixed agent, run `send`, approve it as the human; return the plaintext and the agent's relay frame."""
    relay_url, log = logging_relay
    human_kp = generate_keypair()
    human_pubkey_hex = to_hex(human_kp.public_key)

    def respond(req: Dict[str, Any], _agent_pub: str) -> Dict[str, Any]:
        return {"request_id": req["request_id"], "status": "approved", "tx_hash": "0xabc"}

    ws, _received, listener_task = await simulate_human(human_kp, relay_url, respond)
    try:
        agent = ClankerWallet(secret_key=AGENT_SECRET)
        agent.pair(json.dumps({"version": 1, "pubkey": human_pubkey_hex, "relay": relay_url, **pairing}))
        assert await send(agent) == "0xabc"
        frame = next(
            m for m in log if m.get("type") == "message" and json.loads(m["payload"])["sender_pubkey"] != human_pubkey_hex
        )
        envelope = json.loads(frame["payload"])
        plaintext = decrypt_message(envelope["ciphertext"], from_hex(envelope["sender_pubkey"]), human_kp.secret_key)
        assert plaintext is not None
        return plaintext, frame
    finally:
        listener_task.cancel()
        await ws.close()


def _signature_verifies(plaintext: str) -> bool:
    """The web app's check: the signature covers the request as received, with signature set to ""."""
    req = json.loads(plaintext)
    payload = json.dumps({**req, "signature": ""}, separators=(",", ":"))
    signing_pub = ClankerWallet(secret_key=AGENT_SECRET).signing_public_key
    return verify_signature(payload, req["signature"], signing_pub)


def _evm_request(agent: ClankerWallet) -> Any:
    return agent.request_tx(
        RequestTxOptions(
            chain_id=84532,
            transaction=Transaction(to=TO, value=5, data="0xabcd"),
            context=TxContext(reason="pay", urgency="low", expected_outcome="paid"),
            timeout_ms=10000,
        )
    )


class TestWire:
    async def test_evm_request_is_unchanged(self, frozen: None, logging_relay: Tuple[str, List[Dict[str, Any]]]) -> None:
        assert keypair_from_secret(AGENT_SECRET).public_key.hex().startswith("13be4feaeaf2")
        plaintext, frame = await _capture(logging_relay, {"wallet": RECIPIENT, "mode": "managed"}, _evm_request)
        assert plaintext == EVM_PLAINTEXT
        assert frame["simulate"] == {"from": RECIPIENT, "to": TO, "value": "5", "data": "0xabcd", "chainId": 84532}

    async def test_chia_transfer(self, frozen: None, logging_relay: Tuple[str, List[Dict[str, Any]]]) -> None:
        plaintext, frame = await _capture(
            logging_relay,
            {"wallet": "xch1me", "mode": "managed", "chain_family": "chia"},
            lambda agent: agent.request_transfer(
                RequestTransferOptions(
                    chain_network="testnet11",
                    transfer=Transfer(asset="xch", to=TXCH, amount=5),
                    context=TxContext(reason="pay"),
                    timeout_ms=10000,
                )
            ),
        )
        req = json.loads(plaintext)
        assert list(req) == [
            "request_id", "agent_id", "timestamp", "chain_family", "chain_network", "transfer", "signature", "context",
        ]
        assert req["request_id"] == FROZEN_REQUEST_ID
        assert req["chain_family"] == "chia"
        assert req["chain_network"] == "testnet11"
        assert req["transfer"] == {"asset": "xch", "to": TXCH, "amount": "5", "fee": "0"}
        assert req["context"] == {"reason": "pay"}
        assert _signature_verifies(plaintext)
        # the relay simulator is evm-only
        assert "simulate" not in frame

    async def test_bitcoin_transfer_has_no_fee(self, logging_relay: Tuple[str, List[Dict[str, Any]]]) -> None:
        plaintext, _frame = await _capture(
            logging_relay,
            {"wallet": "tb1me", "chain_family": "bitcoin", "chain_network": "testnet"},
            lambda agent: agent.request_transfer(
                RequestTransferOptions(
                    chain_network="testnet", transfer=Transfer(asset="btc", to=BTC_TEST, amount="1000"), timeout_ms=10000
                )
            ),
        )
        req = json.loads(plaintext)
        assert req["transfer"] == {"asset": "btc", "to": BTC_TEST, "amount": "1000"}
        assert "context" not in req
        assert "chain_id" not in req and "transaction" not in req
        assert _signature_verifies(plaintext)

    @pytest.mark.parametrize(
        "pairing,network,transfer,field",
        [
            ({}, "testnet11", Transfer(asset="xch", to=TXCH, amount=1), "chain_family"),
            ({"chain_family": "chia", "chain_network": "mainnet"}, "testnet11", Transfer(asset="xch", to=TXCH, amount=1), "chain_network"),
            ({"chain_family": "bitcoin"}, "mainnet", Transfer(asset="btc", to=BTC_TEST, amount=1), "to"),
        ],
    )
    async def test_transfer_rejected_before_connecting(
        self,
        logging_relay: Tuple[str, List[Dict[str, Any]]],
        pairing: Dict[str, Any],
        network: str,
        transfer: Transfer,
        field: str,
    ) -> None:
        relay_url, log = logging_relay
        agent = ClankerWallet()
        agent.pair(json.dumps({"version": 1, "pubkey": to_hex(generate_keypair().public_key), "relay": relay_url, **pairing}))
        with pytest.raises(InvalidTxError) as exc:
            await agent.request_transfer(RequestTransferOptions(chain_network=network, transfer=transfer, timeout_ms=2000))
        assert exc.value.field == field
        assert log == []

    async def test_transfer_needs_pairing(self) -> None:
        with pytest.raises(NotPairedError):
            await ClankerWallet().request_transfer(
                RequestTransferOptions(chain_network="testnet11", transfer=Transfer(asset="xch", to=TXCH, amount=1))
            )

    def test_pair_keeps_chain_family_and_network(self) -> None:
        data = ClankerWallet().pair(
            json.dumps({"version": 1, "pubkey": "aa", "relay": "ws://x", "chain_family": "chia", "chain_network": "testnet11"})
        )
        assert data.chain_family == "chia"
        assert data.chain_network == "testnet11"
        evm = ClankerWallet().pair(json.dumps({"version": 1, "pubkey": "aa", "relay": "ws://x"}))
        assert evm.chain_family is None and evm.chain_network is None
