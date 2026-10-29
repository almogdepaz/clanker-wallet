"""Bech32 / bech32m decoding — mirrors src/bech32.test.ts (BIP-173 / BIP-350 test vectors)."""

from __future__ import annotations

from typing import List

import pytest

from clanker_wallet.bech32 import bech32_decode, decode_chia_address, decode_segwit_address

VALID_BECH32 = [
    "A12UEL5L",
    "a12uel5l",
    "an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs",
    "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
    "11qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8247j",
    "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
    "?1ezyfcl",
]

VALID_BECH32M = [
    "A1LQFN3A",
    "a1lqfn3a",
    "an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6",
    "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
    "11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8",
    "split1checkupstagehandshakeupstreamerranterredcaperredlc445v",
    "?1v759aa",
]

INVALID_BECH32 = [
    "\x201nwldj5",
    "\x7f1axkwrx",
    "\x801eym55h",
    "an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx",
    "pzry9x0s0muk",
    "1pzry9x0s0muk",
    "x1b4n0q5v",
    "li1dgmt3",
    "de1lg7wt\xff",
    "A1G7SGD8",
    "10a06t8",
    "1qzzfhee",
]

INVALID_BECH32M = [
    "\x201xj0phk",
    "\x7f1g6xzxy",
    "\x801vctc34",
    "an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4",
    "qyrz8wqd2c9m",
    "1qyrz8wqd2c9m",
    "y1b0jsk6g",
    "lt1igcx5c0",
    "in1muywd",
    "mm1crxm3i",
    "au1s5cgom",
    "M1VUXWEZ",
    "16plkw9",
    "1p2gdwpf",
]

VALID_SEGWIT = [
    ("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "0014751e76e8199196d454941c45d1b3a323f1433bd6"),
    ("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262"),
    ("bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y", "5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6"),
    ("BC1SW50QGDZ25J", "6002751e"),
    ("bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "5210751e76e8199196d454941c45d1b3a323"),
    ("tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy", "0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433"),
    ("tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c", "5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433"),
    ("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
]

INVALID_SEGWIT = [
    "tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut",
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd",
    "tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf",
    "BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL",
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh",
    "tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47",
    "bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4",
    "BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R",
    "bc1pw5dgrnzv",
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav",
    "BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P",
    "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq",
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf",
    "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j",
    "bc1gmk9yu",
]


def script_pubkey(version: int, program: List[int]) -> str:
    """scriptPubKey: OP_n (0x00 or 0x50+n), push length, program."""
    op = 0 if version == 0 else version + 0x50
    return bytes([op, len(program), *program]).hex()


@pytest.mark.parametrize("s", VALID_BECH32)
def test_accepts_bech32(s: str) -> None:
    decoded = bech32_decode(s)
    assert decoded is not None and decoded[2] == "bech32"


@pytest.mark.parametrize("s", VALID_BECH32M)
def test_accepts_bech32m(s: str) -> None:
    decoded = bech32_decode(s)
    assert decoded is not None and decoded[2] == "bech32m"


@pytest.mark.parametrize("s", INVALID_BECH32 + INVALID_BECH32M)
def test_rejects_invalid(s: str) -> None:
    assert bech32_decode(s) is None


@pytest.mark.parametrize("addr,spk", VALID_SEGWIT)
def test_decodes_segwit(addr: str, spk: str) -> None:
    decoded = decode_segwit_address(addr[:2].lower(), addr)
    assert decoded is not None
    assert script_pubkey(*decoded) == spk


@pytest.mark.parametrize("addr", INVALID_SEGWIT)
def test_rejects_invalid_segwit(addr: str) -> None:
    assert decode_segwit_address("bc", addr) is None
    assert decode_segwit_address("tb", addr) is None


def test_rejects_segwit_under_the_other_network_hrp() -> None:
    assert decode_segwit_address("tb", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4") is None


# puzzle hash 0x000102…1f, encoded with the reference implementation
PUZZLE_HASH = list(range(32))
XCH = "xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0srg6dkm"
TXCH = "txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg"


def test_decodes_chia_puzzle_hashes() -> None:
    assert decode_chia_address("xch", XCH) == PUZZLE_HASH
    assert decode_chia_address("txch", TXCH) == PUZZLE_HASH


def test_rejects_chia_wrong_network() -> None:
    assert decode_chia_address("xch", TXCH) is None
    assert decode_chia_address("txch", XCH) is None


def test_rejects_chia_bech32_wrong_length_and_bad_checksum() -> None:
    assert decode_chia_address("xch", "xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sk52pne") is None
    assert decode_chia_address("xch", "xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnlgaqhp") is None
    assert decode_chia_address("xch", XCH[:-1] + "n") is None
