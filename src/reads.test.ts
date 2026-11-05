import { describe, it, expect, vi } from 'vitest'
import { getBalance, getTxStatus } from './reads.js'
import type { ChainDataOptions } from './chain-data.js'
const ADDRESS = '0x' + '1'.repeat(40)
const BTC = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
const XCH = 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg'
const HASH = '0x' + 'ab'.repeat(32)
const response = (body: unknown) => ({ fetch: vi.fn(async () => new Response(JSON.stringify(body))) }) satisfies ChainDataOptions

describe('read response and input boundaries', () => {
  it.each([
    { family: 'evm', chain_id: 1, address: '../secret' },
    { family: 'evm', chain_id: 1, network: 'mainnet', address: ADDRESS },
    { family: 'bitcoin', network: 'testnet11', address: BTC },
    { family: 'bitcoin', network: 'mainnet', address: BTC },
    { family: 'bitcoin', network: 'testnet', address: BTC.slice(0, -1) + 'q' },
    { family: 'bitcoin', network: 'testnet', address: BTC, token: 'BTC' },
    { family: 'chia', network: 'mainnet', address: XCH },
    { family: 'chia', network: 'testnet11', address: XCH.slice(0, -1) + 'q' },
  ])('refuses wrong networks/addresses/options before outbound calls %j', async args => {
    const options = response({})
    await expect(getBalance(args, options)).rejects.toThrow()
    expect(options.fetch).not.toHaveBeenCalled()
  })
  it('supports a valid legacy bitcoin address, but refuses wrong networks and checksum corruption', async () => {
    const options = response({ chain_stats: { funded_txo_sum: 1, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } })
    const address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
    expect(await getBalance({ family: 'bitcoin', network: 'mainnet', address }, options)).toMatchObject({ raw_balance: '1' })
    options.fetch.mockClear()
    await expect(getBalance({ family: 'bitcoin', network: 'testnet', address }, options)).rejects.toThrow('network')
    await expect(getBalance({ family: 'bitcoin', network: 'mainnet', address: address.slice(0, -1) + 'b' }, options)).rejects.toThrow('checksum')
    expect(options.fetch).not.toHaveBeenCalled()
  })
  it.each([{}, { result: '0x00' }, { result: '0xgg' }, { result: -1 }, { error: { message: 'rate limited' } }])('refuses malformed EVM balances %j', async body => {
    await expect(getBalance({ family: 'evm', chain_id: 1, address: ADDRESS }, response(body))).rejects.toThrow()
  })
  it('refuses unsafe bitcoin sums instead of rounding them', async () => {
    const options = response({ chain_stats: { funded_txo_sum: Number.MAX_SAFE_INTEGER + 1, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } })
    await expect(getBalance({ family: 'bitcoin', network: 'testnet', address: BTC }, options)).rejects.toThrow('integer')
  })
  it.each([{}, { success: false, coin_records: [] }, { success: true }, { success: true, coin_records: [{}] }])('refuses malformed Chia coin responses %j', async body => {
    await expect(getBalance({ family: 'chia', network: 'testnet11', address: XCH }, response(body))).rejects.toThrow()
  })
  it('checks coin identities and refuses duplicates/foreign or fractional amounts', async () => {
    const coin = { parent_coin_info: '0x' + 'aa'.repeat(32), puzzle_hash: '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', amount: '1' }
    for (const records of [
      [{ spent: false, coin }, { spent: false, coin }],
      [{ spent: false, coin: { ...coin, puzzle_hash: '0x' + 'bb'.repeat(32) } }],
      [{ spent: false, coin: { ...coin, amount: '1.5' } }],
      [{ spent: false, coin: { ...coin, amount: (2n ** 64n).toString() } }],
    ]) await expect(getBalance({ family: 'chia', network: 'testnet11', address: XCH }, response({ success: true, coin_records: records }))).rejects.toThrow()
    expect(await getBalance({ family: 'chia', network: 'testnet11', address: XCH }, response({ success: true, coin_records: [{ spent: true, coin }] }))).toMatchObject({ raw_balance: '0' })
  })
  it('marks missing or unconfirmed bitcoin hashes without inventing confirmations', async () => {
    for (const [options, status] of [[{ fetch: async () => new Response('', { status: 404 }) }, 'unknown'], [response({ confirmed: false }), 'pending']] as const) {
      expect(await getTxStatus({ family: 'bitcoin', network: 'testnet', tx_hash: 'ab'.repeat(32) }, options)).toMatchObject({ status, confirmations: 0 })
    }
  })
  it.each([{ result: {} }, { result: { status: '0x2', blockNumber: '0x1' } }, { result: { status: '0x1' } }])('refuses incomplete EVM receipts %j', async body => {
    await expect(getTxStatus({ family: 'evm', chain_id: 1, tx_hash: HASH }, response(body))).rejects.toThrow()
  })
  it('refuses an inconsistent EVM receipt/tip rather than a negative confirmation count', async () => {
    const options = { fetch: vi.fn(async (_url, init) => new Response(JSON.stringify({ result: JSON.parse(init!.body as string).method === 'eth_blockNumber' ? '0x1' : { status: '0x1', blockNumber: '0x2' } }))) } satisfies ChainDataOptions
    await expect(getTxStatus({ family: 'evm', chain_id: 1, tx_hash: HASH }, options)).rejects.toThrow('inconsistent')
  })
})
