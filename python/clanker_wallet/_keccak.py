"""keccak-256 (the pre-NIST padding ethereum uses), only for EIP-55 address checksums.

hashlib.sha3_256 is NIST SHA3-256, which pads differently and gives other digests.
Mirrors src/keccak.ts.
"""

from __future__ import annotations

from typing import List

_MASK64 = (1 << 64) - 1
_RATE_BYTES = 136


def _rotl(x: int, n: int) -> int:
    return ((x << n) | (x >> (64 - n))) & _MASK64 if n else x


def _round_constants() -> List[int]:
    # degree-8 LFSR from the keccak reference
    out: List[int] = []
    r = 1
    for _ in range(24):
        rc = 0
        for j in range(7):
            if r & 1:
                rc |= 1 << ((1 << j) - 1)
            r = ((r << 1) ^ 0x71) & 0xFF if r & 0x80 else (r << 1) & 0xFF
        out.append(rc)
    return out


def _rotations() -> List[int]:
    # rho offsets, indexed by x + 5y
    out = [0] * 25
    x, y = 1, 0
    for t in range(24):
        out[x + 5 * y] = ((t + 1) * (t + 2) // 2) % 64
        x, y = y, (2 * x + 3 * y) % 5
    return out


_ROUND_CONSTANTS = _round_constants()
_ROTATIONS = _rotations()


def _keccak_f(a: List[int]) -> None:
    b = [0] * 25
    for rc in _ROUND_CONSTANTS:
        # theta
        c = [a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] for x in range(5)]
        for x in range(5):
            d = c[(x + 4) % 5] ^ _rotl(c[(x + 1) % 5], 1)
            for y in range(0, 25, 5):
                a[x + y] ^= d
        # rho + pi
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rotl(a[x + 5 * y], _ROTATIONS[x + 5 * y])
        # chi
        for y in range(0, 25, 5):
            for x in range(5):
                a[x + y] = b[x + y] ^ (~b[(x + 1) % 5 + y] & _MASK64 & b[(x + 2) % 5 + y])
        # iota
        a[0] ^= rc


def keccak256(data: bytes) -> bytes:
    # pad10*1 with keccak's 0x01 domain byte
    padded = bytearray(data)
    padded += bytes((len(data) // _RATE_BYTES + 1) * _RATE_BYTES - len(data))
    padded[len(data)] ^= 0x01
    padded[-1] ^= 0x80

    state = [0] * 25
    for off in range(0, len(padded), _RATE_BYTES):
        for i in range(_RATE_BYTES // 8):
            state[i] ^= int.from_bytes(padded[off + 8 * i : off + 8 * i + 8], "little")
        _keccak_f(state)

    return b"".join(lane.to_bytes(8, "little") for lane in state[:4])
