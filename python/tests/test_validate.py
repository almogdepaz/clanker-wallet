"""Tx validation — mirrors src/validate.test.ts."""

from __future__ import annotations

from typing import Any, Optional

import pytest

from clanker_wallet import ClankerError, InvalidTxError, Transaction, validate_tx
from clanker_wallet._keccak import keccak256
from clanker_wallet.validate import is_checksum_address

TO = "0x000000000000000000000000000000000000dEaD"


def rejected_field(chain_id: Any, to: Any = TO, value: Any = "0", data: Any = "0x") -> Optional[str]:
    """The field validate_tx rejects, or None if it accepts."""
    try:
        validate_tx(chain_id, Transaction(to=to, value=value, data=data))
        return None
    except InvalidTxError as err:
        return err.field


@pytest.mark.parametrize(
    "data,digest",
    [
        (b"", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"),
        (b"abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"),
        # longer than one 136-byte block
        (b"a" * 200, "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d"),
    ],
)
def test_keccak256(data: bytes, digest: str) -> None:
    assert keccak256(data).hex() == digest


@pytest.mark.parametrize(
    "address",
    [
        # EIP-55 spec vectors
        "0x52908400098527886E0F7030069857D2E4169EE7",
        "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
        "0xde709f2102306220921060314715629080e2fb77",
        "0x27b1fdb04752bbc536007a920d24acb045561c26",
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
        "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
        "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
        "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ],
)
def test_checksum_vectors(address: str) -> None:
    assert is_checksum_address(address)


def test_checksum_rejects_flipped_letter() -> None:
    assert not is_checksum_address("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")


def test_accepts_plain_transfer_with_default_data() -> None:
    chain_id, tx = validate_tx(84532, Transaction(to=TO, value="1000"))
    assert chain_id == 84532
    assert tx == Transaction(to=TO, value="1000", data="0x")


def test_int_value_becomes_decimal_string() -> None:
    _, tx = validate_tx(1, Transaction(to=TO, value=10**18, data="0xabcd"))
    assert tx == Transaction(to=TO, value="1000000000000000000", data="0xabcd")


def test_error_is_a_value_error_and_clanker_error() -> None:
    with pytest.raises(ValueError):
        validate_tx(1, Transaction(to="0x...", value="0"))
    with pytest.raises(ClankerError):
        validate_tx(1, Transaction(to="0x...", value="0"))


@pytest.mark.parametrize("chain_id", [0, -1, 1.5, "1", True, None])
def test_rejects_chain_id(chain_id: Any) -> None:
    assert rejected_field(chain_id) == "chain_id"


@pytest.mark.parametrize(
    "to",
    [
        "0x...",
        "0xRecipient",
        TO[:-1],
        TO + "0",
        TO[2:],
        # bad EIP-55 checksum
        "0x000000000000000000000000000000000000dEAD",
        "",
        None,
        True,
    ],
)
def test_rejects_to(to: Any) -> None:
    assert rejected_field(1, to=to) == "to"


@pytest.mark.parametrize("to", [TO.lower(), "0x000000000000000000000000000000000000DEAD"])
def test_accepts_single_case_to(to: str) -> None:
    assert rejected_field(1, to=to) is None


@pytest.mark.parametrize("value", ["1.5", "-1", "1e18", "", " 1", "0x10", "１", 1.0, -1, True, None])
def test_rejects_value(value: Any) -> None:
    assert rejected_field(1, value=value) == "value"


@pytest.mark.parametrize(
    "data",
    [
        "abcd",
        "0xabc",
        "0xzz",
        # the SKILL.md erc-20 example from the prod e2e report: placeholder text inside the hex
        "0xa9059cbb000000000000000000000000RecipientAddr00000000000000000000000000000000000000000000000000000000000f4240",
        5,
        None,
    ],
)
def test_rejects_data(data: Any) -> None:
    assert rejected_field(1, data=data) == "data"


def test_message_names_the_field() -> None:
    with pytest.raises(InvalidTxError, match=r"\bto\b.*0x\.\.\."):
        validate_tx(1, Transaction(to="0x...", value="0"))
