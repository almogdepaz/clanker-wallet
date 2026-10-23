"""Transfer validation — mirrors src/transfer.test.ts."""

from __future__ import annotations

from typing import Any

import pytest

from clanker_wallet.errors import InvalidTxError
from clanker_wallet.types import Transfer
from clanker_wallet.validate import validate_transfer

BTC_MAIN = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
BTC_TEST = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"
XCH = "xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0srg6dkm"
TXCH = "txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg"
# p2wsh (v0, 32 bytes) and p2tr (v1, 32 bytes)
BTC_P2WSH = "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"
BTC_P2TR = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
# valid bech32m but not spendable today: v16 2-byte, v2 16-byte, v1 40-byte programs
BTC_NONSTANDARD = [
    "BC1SW50QGDZ25J",
    "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs",
    "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
]


def fails(family: Any, network: Any, transfer: Transfer) -> InvalidTxError:
    with pytest.raises(InvalidTxError) as exc:
        validate_transfer(family, network, transfer)
    return exc.value


def test_bitcoin_normalizes_a_mainnet_transfer() -> None:
    assert validate_transfer("bitcoin", "mainnet", Transfer(asset="btc", to=BTC_MAIN, amount=1000)) == (
        "bitcoin",
        "mainnet",
        Transfer(asset="btc", to=BTC_MAIN, amount="1000"),
    )


def test_bitcoin_accepts_testnet_and_signet_and_keeps_the_address_as_given() -> None:
    assert validate_transfer("bitcoin", "testnet", Transfer(asset="btc", to=BTC_TEST, amount="1"))[2].to == BTC_TEST
    upper = BTC_TEST.upper()
    assert validate_transfer("bitcoin", "signet", Transfer(asset="btc", to=upper, amount="1"))[2].to == upper


@pytest.mark.parametrize("to", [BTC_MAIN, BTC_P2WSH, BTC_P2TR])
def test_bitcoin_accepts_p2wpkh_p2wsh_and_p2tr(to: str) -> None:
    assert validate_transfer("bitcoin", "mainnet", Transfer(asset="btc", to=to, amount="1"))[2].to == to


@pytest.mark.parametrize("to", BTC_NONSTANDARD)
def test_bitcoin_rejects_a_future_segwit_version_or_program_size(to: str) -> None:
    err = fails("bitcoin", "mainnet", Transfer(asset="btc", to=to, amount="1"))
    assert err.field == "to"
    assert "not a bitcoin mainnet address" in err.reason


@pytest.mark.parametrize(
    "field,network,transfer,reason",
    [
        ("to", "mainnet", Transfer(asset="btc", to=BTC_TEST, amount="1"), "not a bitcoin mainnet address"),
        ("to", "testnet", Transfer(asset="btc", to=BTC_MAIN, amount="1"), "not a bitcoin testnet address"),
        ("to", "mainnet", Transfer(asset="btc", to="1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", amount="1"), "segwit"),
        ("fee", "mainnet", Transfer(asset="btc", to=BTC_MAIN, amount="1", fee="10"), "the wallet sets"),
        ("fee", "mainnet", Transfer(asset="btc", to=BTC_MAIN, amount="1", fee=0), "the wallet sets"),
        ("amount", "mainnet", Transfer(asset="btc", to=BTC_MAIN, amount="9007199254740992"), "at most"),
        ("asset", "mainnet", Transfer(asset="xch", to=BTC_MAIN, amount="1"), "'btc'"),
        ("chain_network", "regtest", Transfer(asset="btc", to=BTC_MAIN, amount="1"), "mainnet, testnet or signet"),
    ],
)
def test_bitcoin_rejects(field: str, network: str, transfer: Transfer, reason: str) -> None:
    err = fails("bitcoin", network, transfer)
    assert err.field == field
    assert reason in err.reason


def test_chia_defaults_the_fee_to_0_mojos() -> None:
    assert validate_transfer("chia", "mainnet", Transfer(asset="xch", to=XCH, amount="1000")) == (
        "chia",
        "mainnet",
        Transfer(asset="xch", to=XCH, amount="1000", fee="0"),
    )


def test_chia_keeps_an_agent_set_fee() -> None:
    assert validate_transfer("chia", "testnet11", Transfer(asset="xch", to=TXCH, amount=5, fee=50))[2] == Transfer(
        asset="xch", to=TXCH, amount="5", fee="50"
    )


@pytest.mark.parametrize(
    "field,network,transfer,reason",
    [
        ("to", "mainnet", Transfer(asset="xch", to=TXCH, amount="1"), "not a chia mainnet address"),
        ("to", "testnet11", Transfer(asset="xch", to=XCH, amount="1"), "not a chia testnet11 address"),
        ("fee", "mainnet", Transfer(asset="xch", to=XCH, amount="1", fee="-1"), "non-negative"),
        ("fee", "mainnet", Transfer(asset="xch", to=XCH, amount="1", fee="1.5"), "non-negative"),
        ("fee", "mainnet", Transfer(asset="xch", to=XCH, amount="1", fee=-1), "non-negative"),
        ("chain_network", "testnet", Transfer(asset="xch", to=TXCH, amount="1"), "mainnet or testnet11"),
    ],
)
def test_chia_rejects(field: str, network: str, transfer: Transfer, reason: str) -> None:
    err = fails("chia", network, transfer)
    assert err.field == field
    assert reason in err.reason


# bool is an int subclass; True is not an amount
@pytest.mark.parametrize("amount", ["0", "-5", "1.5", "1e3", "007", "", " 1", 0, -1, True, 1.0, None])
def test_rejects_amount(amount: Any) -> None:
    assert fails("chia", "mainnet", Transfer(asset="xch", to=XCH, amount=amount)).field == "amount"


@pytest.mark.parametrize("family", ["evm", None])
def test_needs_a_bitcoin_or_chia_pairing(family: Any) -> None:
    err = fails(family, "mainnet", Transfer(asset="btc", to=BTC_MAIN, amount="1"))
    assert err.field == "chain_family"
    assert str(err) == "invalid chain_family: transfers need a bitcoin or chia pairing, got 'evm'"
