"""Cryptographic primitives for Clanker Wallet SDK.

Mirrors sdk/src/crypto.ts — x25519 keypair, nacl.box encrypt/decrypt,
Ed25519 signing, hex/base64 helpers.

Uses PyNaCl (libsodium bindings).
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass

import nacl.bindings
import nacl.public
import nacl.signing
import nacl.utils

# nacl.box nonce length (24 bytes)
_NONCE_LENGTH = nacl.bindings.crypto_box_NONCEBYTES  # 24


@dataclass(frozen=True, slots=True)
class BoxKeyPair:
    """x25519 public/secret keypair."""

    public_key: bytes
    secret_key: bytes


@dataclass(frozen=True, slots=True)
class SignKeyPair:
    """Ed25519 signing keypair."""

    public_key: bytes  # 32 bytes
    secret_key: bytes  # 64 bytes


def generate_keypair() -> BoxKeyPair:
    """Generate a random x25519 keypair for the agent's identity."""
    sk = nacl.public.PrivateKey.generate()
    return BoxKeyPair(
        public_key=bytes(sk.public_key),
        secret_key=bytes(sk),
    )


def keypair_from_secret(secret_key: bytes) -> BoxKeyPair:
    """Restore x25519 keypair from a 32-byte secret key."""
    sk = nacl.public.PrivateKey(secret_key)
    return BoxKeyPair(
        public_key=bytes(sk.public_key),
        secret_key=bytes(sk),
    )


def encrypt_message(
    message: str,
    recipient_public_key: bytes,
    sender_secret_key: bytes,
) -> str:
    """Encrypt a message using nacl.box.

    Returns base64(nonce + ciphertext), matching the TS SDK wire format.
    """
    nonce = os.urandom(_NONCE_LENGTH)
    encoded = message.encode("utf-8")

    # raw nacl.box (no pynacl Box wrapper — matches tweetnacl behavior exactly)
    ciphertext = nacl.bindings.crypto_box(
        encoded, nonce, recipient_public_key, sender_secret_key
    )

    combined = nonce + ciphertext
    return bytes_to_base64(combined)


def decrypt_message(
    base64_payload: str,
    sender_public_key: bytes,
    recipient_secret_key: bytes,
) -> str | None:
    """Decrypt a nacl.box message. Payload = base64(nonce + ciphertext).

    Returns None on decryption failure.
    """
    raw = base64_to_bytes(base64_payload)
    if len(raw) <= _NONCE_LENGTH:
        return None

    nonce = raw[:_NONCE_LENGTH]
    ciphertext = raw[_NONCE_LENGTH:]

    try:
        plaintext = nacl.bindings.crypto_box_open(
            ciphertext, nonce, sender_public_key, recipient_secret_key
        )
    except nacl.exceptions.CryptoError:
        return None

    return plaintext.decode("utf-8")


def signing_keypair_from_seed(seed: bytes) -> SignKeyPair:
    """Derive an Ed25519 signing keypair from a 32-byte seed."""
    sk = nacl.signing.SigningKey(seed)
    return SignKeyPair(
        public_key=bytes(sk.verify_key),
        secret_key=bytes(sk._signing_key),
    )


def sign_message(message: str, signing_secret_key: bytes) -> str:
    """Sign a message with an Ed25519 secret key.

    Returns base64(64-byte detached signature).
    """
    encoded = message.encode("utf-8")
    # signing_secret_key is 64 bytes (seed + public)
    sk = nacl.signing.SigningKey(signing_secret_key[:32])
    signed = sk.sign(encoded)
    # detached signature = first 64 bytes of signed message
    signature = signed.signature
    return bytes_to_base64(signature)


def verify_signature(
    message: str,
    base64_signature: str,
    signing_public_key: bytes,
) -> bool:
    """Verify a detached Ed25519 signature. Signature is base64-encoded."""
    encoded = message.encode("utf-8")
    signature = base64_to_bytes(base64_signature)
    vk = nacl.signing.VerifyKey(signing_public_key)
    try:
        vk.verify(encoded, signature)
        return True
    except nacl.exceptions.BadSignatureError:
        return False


def to_hex(data: bytes) -> str:
    """Hex-encode bytes (no 0x prefix)."""
    return data.hex()


def from_hex(hex_str: str) -> bytes:
    """Hex string to bytes (strips 0x prefix if present)."""
    clean = hex_str[2:] if hex_str.startswith("0x") else hex_str
    return bytes.fromhex(clean)


def bytes_to_base64(data: bytes) -> str:
    """Encode bytes as standard base64 string."""
    return base64.b64encode(data).decode("ascii")


def base64_to_bytes(b64: str) -> bytes:
    """Decode standard base64 string to bytes."""
    return base64.b64decode(b64)
