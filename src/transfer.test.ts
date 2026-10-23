import { describe, it, expect } from 'vitest'
import { InvalidTxError, validateTransfer } from './validate.js'

const BTC_MAIN = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const BTC_TEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const XCH = 'xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0srg6dkm'
const TXCH = 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg'
/** p2wsh (v0, 32 bytes) and p2tr (v1, 32 bytes) */
const BTC_P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'
const BTC_P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
/** valid bech32m but not spendable today: v16 2-byte, v2 16-byte, v1 40-byte programs */
const BTC_NONSTANDARD = [
  'BC1SW50QGDZ25J',
  'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
  'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
]

function fails(fn: () => unknown): InvalidTxError {
  try { fn() } catch (err) {
    expect(err).toBeInstanceOf(InvalidTxError)
    return err as InvalidTxError
  }
  throw new Error('did not throw')
}

describe('validateTransfer: bitcoin', () => {
  it('normalizes a mainnet transfer', () => {
    expect(validateTransfer('bitcoin', 'mainnet', { asset: 'btc', to: BTC_MAIN, amount: 1000n }))
      .toEqual({ chain_family: 'bitcoin', chain_network: 'mainnet', transfer: { asset: 'btc', to: BTC_MAIN, amount: '1000' } })
  })

  it('accepts testnet and signet tb1 recipients, and keeps the address as given', () => {
    expect(validateTransfer('bitcoin', 'testnet', { asset: 'btc', to: BTC_TEST, amount: '1' }).transfer.to).toBe(BTC_TEST)
    expect(validateTransfer('bitcoin', 'signet', { asset: 'btc', to: BTC_TEST.toUpperCase(), amount: '1' }).transfer.to)
      .toBe(BTC_TEST.toUpperCase())
  })

  it('accepts p2wpkh, p2wsh and p2tr recipients', () => {
    for (const to of [BTC_MAIN, BTC_P2WSH, BTC_P2TR]) {
      expect(validateTransfer('bitcoin', 'mainnet', { asset: 'btc', to, amount: '1' }).transfer.to).toBe(to)
    }
  })

  it.each(BTC_NONSTANDARD)('rejects a future segwit version or program size: %s', (to) => {
    const err = fails(() => validateTransfer('bitcoin', 'mainnet', { asset: 'btc', to, amount: '1' }))
    expect(err.field).toBe('to')
    expect(err.reason).toContain('not a bitcoin mainnet address')
  })

  it.each([
    ['to', 'mainnet', { asset: 'btc', to: BTC_TEST, amount: '1' }, 'not a bitcoin mainnet address'],
    ['to', 'testnet', { asset: 'btc', to: BTC_MAIN, amount: '1' }, 'not a bitcoin testnet address'],
    ['to', 'mainnet', { asset: 'btc', to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', amount: '1' }, 'segwit'],
    ['fee', 'mainnet', { asset: 'btc', to: BTC_MAIN, amount: '1', fee: '10' }, 'the wallet sets'],
    ['amount', 'mainnet', { asset: 'btc', to: BTC_MAIN, amount: '9007199254740992' }, 'at most'],
    ['asset', 'mainnet', { asset: 'xch', to: BTC_MAIN, amount: '1' }, '"btc"'],
    ['chain_network', 'regtest', { asset: 'btc', to: BTC_MAIN, amount: '1' }, 'mainnet, testnet or signet'],
  ])('rejects a bad %s', (field, network, transfer, reason) => {
    const err = fails(() => validateTransfer('bitcoin', network, transfer))
    expect(err.field).toBe(field)
    expect(err.reason).toContain(reason)
  })
})

describe('validateTransfer: chia', () => {
  it('defaults the fee to 0 mojos', () => {
    expect(validateTransfer('chia', 'mainnet', { asset: 'xch', to: XCH, amount: '1000' }))
      .toEqual({ chain_family: 'chia', chain_network: 'mainnet', transfer: { asset: 'xch', to: XCH, amount: '1000', fee: '0' } })
  })

  it('keeps an agent-set fee', () => {
    expect(validateTransfer('chia', 'testnet11', { asset: 'xch', to: TXCH, amount: 5n, fee: 50n }).transfer)
      .toEqual({ asset: 'xch', to: TXCH, amount: '5', fee: '50' })
  })

  it.each([
    ['to', 'mainnet', { asset: 'xch', to: TXCH, amount: '1' }, 'not a chia mainnet address'],
    ['to', 'testnet11', { asset: 'xch', to: XCH, amount: '1' }, 'not a chia testnet11 address'],
    ['fee', 'mainnet', { asset: 'xch', to: XCH, amount: '1', fee: '-1' }, 'non-negative'],
    ['fee', 'mainnet', { asset: 'xch', to: XCH, amount: '1', fee: '1.5' }, 'non-negative'],
    ['chain_network', 'testnet', { asset: 'xch', to: TXCH, amount: '1' }, 'mainnet or testnet11'],
  ])('rejects a bad %s', (field, network, transfer, reason) => {
    const err = fails(() => validateTransfer('chia', network, transfer))
    expect(err.field).toBe(field)
    expect(err.reason).toContain(reason)
  })
})

describe('validateTransfer: shape', () => {
  it.each(['0', '-5', '1.5', '1e3', '007', '', ' 1', 0n, -1n, 5])('rejects amount %s', (amount) => {
    expect(fails(() => validateTransfer('chia', 'mainnet', { asset: 'xch', to: XCH, amount } as never)).field).toBe('amount')
  })

  it('needs a bitcoin or chia pairing', () => {
    const err = fails(() => validateTransfer('evm', 'mainnet', { asset: 'btc', to: BTC_MAIN, amount: '1' }))
    expect(err.field).toBe('chain_family')
    expect(err.message).toBe('invalid chain_family: transfers need a bitcoin or chia pairing, got "evm"')
  })
})
