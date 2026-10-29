"""Bech32 / Bech32m decoding — mirrors src/bech32.ts.

A port of the BIP-173 / BIP-350 reference implementation
(github.com/sipa/bech32 ref/python/segwit_addr.py). Used to check transfer
recipients: bitcoin segwit addresses and chia puzzle-hash addresses
(bech32m, hrp xch / txch).
"""

from __future__ import annotations

from typing import List, Optional, Tuple

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32M_CONST = 0x2BC830A3
_GENERATOR = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]


def _polymod(values: List[int]) -> int:
    chk = 1
    for value in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ value
        for i in range(5):
            if (top >> i) & 1:
                chk ^= _GENERATOR[i]
    return chk


def _hrp_expand(hrp: str) -> List[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def bech32_decode(bech: str) -> Optional[Tuple[str, List[int], str]]:
    """Validate a bech32/bech32m string; returns (hrp, data without checksum, "bech32" | "bech32m")."""
    if any(ord(c) < 33 or ord(c) > 126 for c in bech):
        return None
    if bech.lower() != bech and bech.upper() != bech:
        return None
    lower = bech.lower()
    pos = lower.rfind("1")
    if pos < 1 or pos + 7 > len(lower) or len(lower) > 90:
        return None
    if not all(c in _CHARSET for c in lower[pos + 1 :]):
        return None
    hrp = lower[:pos]
    data = [_CHARSET.find(c) for c in lower[pos + 1 :]]
    check = _polymod(_hrp_expand(hrp) + data)
    if check == 1:
        encoding = "bech32"
    elif check == _BECH32M_CONST:
        encoding = "bech32m"
    else:
        return None
    return hrp, data[:-6], encoding


def convert_bits(data: List[int], from_bits: int, to_bits: int, pad: bool) -> Optional[List[int]]:
    """General power-of-2 base conversion."""
    acc = 0
    bits = 0
    ret: List[int] = []
    maxv = (1 << to_bits) - 1
    max_acc = (1 << (from_bits + to_bits - 1)) - 1
    for value in data:
        if value < 0 or value >> from_bits:
            return None
        acc = ((acc << from_bits) | value) & max_acc
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (to_bits - bits)) & maxv)
    elif bits >= from_bits or ((acc << (to_bits - bits)) & maxv):
        return None
    return ret


def decode_segwit_address(hrp: str, addr: str) -> Optional[Tuple[int, List[int]]]:
    """Decode a segwit address for the given hrp ("bc" mainnet, "tb" testnet/signet) to (version, program)."""
    decoded = bech32_decode(addr)
    if decoded is None or decoded[0] != hrp or not decoded[1]:
        return None
    _, data, encoding = decoded
    version = data[0]
    program = convert_bits(data[1:], 5, 8, False)
    if program is None or len(program) < 2 or len(program) > 40:
        return None
    if version > 16:
        return None
    if version == 0 and len(program) not in (20, 32):
        return None
    if (version == 0) != (encoding == "bech32"):
        return None
    return version, program



def is_standard_segwit_address(hrp: str, addr: str) -> bool:
    """A segwit address a wallet can pay today: v0 p2wpkh/p2wsh (20/32 bytes) or v1 p2tr (32 bytes).

    Other versions and v1 lengths decode but are unspendable or anyone-can-spend, so transfers refuse them.
    """
    decoded = decode_segwit_address(hrp, addr)
    return decoded is not None and (decoded[0] == 0 or (decoded[0] == 1 and len(decoded[1]) == 32))


def decode_chia_address(hrp: str, addr: str) -> Optional[List[int]]:
    """Decode a chia address (bech32m of a 32-byte puzzle hash) for the given hrp ("xch" / "txch")."""
    decoded = bech32_decode(addr)
    if decoded is None or decoded[0] != hrp or decoded[2] != "bech32m":
        return None
    puzzle_hash = convert_bits(decoded[1], 5, 8, False)
    return puzzle_hash if puzzle_hash is not None and len(puzzle_hash) == 32 else None
