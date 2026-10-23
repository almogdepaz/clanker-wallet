import { describe, it, expect } from 'vitest'
import { InvalidTxError, validateTransfer } from './validate.js'

const BTC_MAIN = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
const BTC_TEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const XCH = 'xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0srg6dkm'
const TXCH = 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg'

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
