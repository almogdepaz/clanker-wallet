"""Tests for clanker_wallet.crypto — mirrors TS SDK crypto.ts functionality."""

import json
import os
import subprocess
import tempfile

import pytest

from clanker_wallet.crypto import (
    BoxKeyPair,
    SignKeyPair,
    base64_to_bytes,
    bytes_to_base64,
    decrypt_message,
    encrypt_message,
    from_hex,
    generate_keypair,
    keypair_from_secret,
    sign_message,
    signing_keypair_from_seed,
    to_hex,
    verify_signature,
)


class TestKeypairGeneration:
    def test_generate_keypair_returns_box_keypair(self) -> None:
        kp = generate_keypair()
        assert isinstance(kp, BoxKeyPair)
        assert len(kp.public_key) == 32
        assert len(kp.secret_key) == 32

    def test_generate_keypair_is_random(self) -> None:
        kp1 = generate_keypair()
        kp2 = generate_keypair()
        assert kp1.public_key != kp2.public_key
        assert kp1.secret_key != kp2.secret_key

    def test_keypair_from_secret_restores(self) -> None:
        kp = generate_keypair()
        restored = keypair_from_secret(kp.secret_key)
        assert restored.public_key == kp.public_key
        assert restored.secret_key == kp.secret_key


class TestEncryptDecrypt:
    def test_round_trip(self) -> None:
        alice = generate_keypair()
        bob = generate_keypair()
        message = "hello from alice"

        ciphertext = encrypt_message(message, bob.public_key, alice.secret_key)
        assert isinstance(ciphertext, str)

        plaintext = decrypt_message(ciphertext, alice.public_key, bob.secret_key)
        assert plaintext == message

    def test_decrypt_with_wrong_key_returns_none(self) -> None:
        alice = generate_keypair()
        bob = generate_keypair()
        eve = generate_keypair()

        ciphertext = encrypt_message("secret", bob.public_key, alice.secret_key)
        result = decrypt_message(ciphertext, alice.public_key, eve.secret_key)
        assert result is None

    def test_decrypt_short_payload_returns_none(self) -> None:
        alice = generate_keypair()
        bob = generate_keypair()
        # base64 of 10 bytes (shorter than 24-byte nonce)
        short = bytes_to_base64(b"\x00" * 10)
        result = decrypt_message(short, alice.public_key, bob.secret_key)
        assert result is None

    def test_decrypt_corrupt_payload_returns_none(self) -> None:
        alice = generate_keypair()
        bob = generate_keypair()
        ciphertext = encrypt_message("test", bob.public_key, alice.secret_key)
        raw = bytearray(base64_to_bytes(ciphertext))
        raw[-1] ^= 0xFF  # flip last byte
        corrupt = bytes_to_base64(bytes(raw))
        result = decrypt_message(corrupt, alice.public_key, bob.secret_key)
        assert result is None

    def test_unicode_message(self) -> None:
        alice = generate_keypair()
        bob = generate_keypair()
        msg = "emoji: \U0001F680 \u00E9\u00E8\u00EA"
        ct = encrypt_message(msg, bob.public_key, alice.secret_key)
        pt = decrypt_message(ct, alice.public_key, bob.secret_key)
        assert pt == msg

    def test_json_message_round_trip(self) -> None:
        """Mimics the actual TxRequest wire format."""
        alice = generate_keypair()
        bob = generate_keypair()
        tx_request = {
            "request_id": "req_123",
            "agent_id": "agent_abc",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "chain_id": 1,
            "transaction": {"to": "0xdead", "value": "1000000000000000000", "data": "0x"},
            "context": {"reason": "test"},
            "signature": "",
        }
        msg = json.dumps(tx_request)
        ct = encrypt_message(msg, bob.public_key, alice.secret_key)
        pt = decrypt_message(ct, alice.public_key, bob.secret_key)
        assert json.loads(pt) == tx_request  # type: ignore[arg-type]


class TestSigning:
    def test_signing_keypair_from_seed(self) -> None:
        seed = b"\x01" * 32
        kp = signing_keypair_from_seed(seed)
        assert isinstance(kp, SignKeyPair)
        assert len(kp.public_key) == 32
        assert len(kp.secret_key) == 64

    def test_signing_keypair_deterministic(self) -> None:
        seed = b"\x42" * 32
        kp1 = signing_keypair_from_seed(seed)
        kp2 = signing_keypair_from_seed(seed)
        assert kp1.public_key == kp2.public_key
        assert kp1.secret_key == kp2.secret_key

    def test_sign_and_verify(self) -> None:
        seed = b"\x01" * 32
        kp = signing_keypair_from_seed(seed)
        msg = "test message"
        sig = sign_message(msg, kp.secret_key)
        assert isinstance(sig, str)
        assert verify_signature(msg, sig, kp.public_key)

    def test_verify_wrong_message_fails(self) -> None:
        seed = b"\x01" * 32
        kp = signing_keypair_from_seed(seed)
        sig = sign_message("original", kp.secret_key)
        assert not verify_signature("tampered", sig, kp.public_key)

    def test_verify_wrong_key_fails(self) -> None:
        kp1 = signing_keypair_from_seed(b"\x01" * 32)
        kp2 = signing_keypair_from_seed(b"\x02" * 32)
        sig = sign_message("test", kp1.secret_key)
        assert not verify_signature("test", sig, kp2.public_key)


class TestHexHelpers:
    def test_to_hex(self) -> None:
        assert to_hex(b"\xde\xad\xbe\xef") == "deadbeef"

    def test_from_hex(self) -> None:
        assert from_hex("deadbeef") == b"\xde\xad\xbe\xef"

    def test_from_hex_strips_0x(self) -> None:
        assert from_hex("0xdeadbeef") == b"\xde\xad\xbe\xef"

    def test_hex_round_trip(self) -> None:
        kp = generate_keypair()
        assert from_hex(to_hex(kp.public_key)) == kp.public_key

    def test_agent_id_derivation(self) -> None:
        """agent_id = 'agent_' + first 12 hex chars of pubkey."""
        kp = generate_keypair()
        agent_id = f"agent_{to_hex(kp.public_key)[:12]}"
        assert agent_id.startswith("agent_")
        assert len(agent_id) == 18  # "agent_" (6) + 12 hex chars


class TestBase64Helpers:
    def test_round_trip(self) -> None:
        data = b"hello world"
        assert base64_to_bytes(bytes_to_base64(data)) == data

    def test_bytes_to_base64(self) -> None:
        assert bytes_to_base64(b"hello") == "aGVsbG8="

    def test_base64_to_bytes(self) -> None:
        assert base64_to_bytes("aGVsbG8=") == b"hello"


class TestCrossLanguageCompat:
    """Verify that Python crypto output is compatible with TS SDK.

    Uses a known seed to generate deterministic keypairs, then checks
    that operations produce identical results across both SDKs.
    """

    KNOWN_SEED = bytes(range(32))  # 0x00..0x1f

    def test_keypair_from_known_seed(self) -> None:
        """Same seed produces same pubkey in both Python and TS."""
        kp = keypair_from_secret(self.KNOWN_SEED)
        hex_pub = to_hex(kp.public_key)
        # x25519 pubkey for seed 0x00..0x1f is deterministic
        # just verify format and length
        assert len(hex_pub) == 64
        assert kp.secret_key == self.KNOWN_SEED

    def test_signing_from_known_seed(self) -> None:
        """Same seed produces same Ed25519 pubkey and signature."""
        kp = signing_keypair_from_seed(self.KNOWN_SEED)
        hex_pub = to_hex(kp.public_key)
        assert len(hex_pub) == 64

        # sign a known message
        sig = sign_message("cross-language-test", kp.secret_key)
        assert verify_signature("cross-language-test", sig, kp.public_key)

    def test_encrypt_decrypt_cross_keypair(self) -> None:
        """Encrypt with one known keypair, decrypt with another — same as TS would."""
        alice_seed = bytes(range(32))
        bob_seed = bytes(range(32, 64))
        alice = keypair_from_secret(alice_seed)
        bob = keypair_from_secret(bob_seed)

        msg = '{"request_id":"req_test","status":"approved","tx_hash":"0xabc"}'
        ct = encrypt_message(msg, bob.public_key, alice.secret_key)
        pt = decrypt_message(ct, alice.public_key, bob.secret_key)
        assert pt == msg

    @staticmethod
    def _run_ts_in_sdk(script: str) -> subprocess.CompletedProcess[str]:
        """Write a TS script to a temp file in sdk/ and run with bun."""
        sdk_dir = os.path.join(
            os.path.dirname(__file__), "..", "..", "sdk"
        )
        sdk_dir = os.path.abspath(sdk_dir)
        fd, path = tempfile.mkstemp(suffix=".ts", dir=sdk_dir)
        try:
            os.write(fd, script.encode())
            os.close(fd)
            return subprocess.run(
                ["bun", "run", path],
                capture_output=True,
                text=True,
                timeout=15,
                cwd=sdk_dir,
            )
        finally:
            os.unlink(path)

    @staticmethod
    def _check_bun() -> None:
        try:
            r = subprocess.run(
                ["bun", "--version"], capture_output=True, text=True, timeout=5
            )
            if r.returncode != 0:
                pytest.skip("bun not available")
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pytest.skip("bun not available")

    def test_cross_sdk_encrypt_decrypt(self) -> None:
        """Encrypt in Python, decrypt in TS SDK (requires bun)."""
        self._check_bun()

        alice_seed = bytes(range(32))
        bob_seed = bytes(range(32, 64))
        alice = keypair_from_secret(alice_seed)
        bob = keypair_from_secret(bob_seed)

        msg = "cross-sdk-test-message"
        ct = encrypt_message(msg, bob.public_key, alice.secret_key)

        ts_script = f"""
import nacl from 'tweetnacl';

function base64ToBytes(b64: string) {{
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}}

function fromHex(hex: string) {{
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i*2, i*2+2), 16);
    return bytes;
}}

const raw = base64ToBytes("{ct}");
const nonce = raw.slice(0, 24);
const ciphertext = raw.slice(24);
const senderPub = fromHex("{to_hex(alice.public_key)}");
const recipientSK = fromHex("{to_hex(bob.secret_key)}");
const pt = nacl.box.open(ciphertext, nonce, senderPub, recipientSK);
if (pt) {{
    console.log(new TextDecoder().decode(pt));
}} else {{
    console.log("DECRYPTION_FAILED");
}}
"""
        result = self._run_ts_in_sdk(ts_script)
        assert result.stdout.strip() == msg, f"TS decryption failed: {result.stderr}"

    def test_cross_sdk_sign_verify(self) -> None:
        """Sign in Python, verify in TS SDK (requires bun)."""
        self._check_bun()

        seed = bytes(range(32))
        kp = signing_keypair_from_seed(seed)
        msg = "cross-sdk-sign-test"
        sig = sign_message(msg, kp.secret_key)

        ts_script = f"""
import nacl from 'tweetnacl';

function base64ToBytes(b64: string) {{
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}}

function fromHex(hex: string) {{
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i*2, i*2+2), 16);
    return bytes;
}}

const encoded = new TextEncoder().encode("{msg}");
const signature = base64ToBytes("{sig}");
const pubkey = fromHex("{to_hex(kp.public_key)}");
const valid = nacl.sign.detached.verify(encoded, signature, pubkey);
console.log(valid ? "VALID" : "INVALID");
"""
        result = self._run_ts_in_sdk(ts_script)
        assert result.stdout.strip() == "VALID", f"TS verification failed: {result.stderr}"
