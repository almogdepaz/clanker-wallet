import { describe, it, expect, vi } from 'vitest'
import { getBalance, getTxStatus } from './reads.js'
import { resolveToken } from './chain-data.js'

const LIMIT = 1024 * 1024
const EVM = { family: 'evm', chain_id: 1, address: '0x' + '1'.repeat(40) }
const BITCOIN = { family: 'bitcoin', network: 'testnet', address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }
const CHIA = { family: 'chia', network: 'testnet11', address: 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg' }
const CASES = [
  { args: EVM, body: JSON.stringify({ result: '0x1' }), balance: '1' },
  { args: BITCOIN, body: JSON.stringify({ chain_stats: { funded_txo_sum: 1, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }), balance: '1' },
  { args: CHIA, body: JSON.stringify({ success: true, coin_records: [] }), balance: '0' },
]

/** A real pull-driven byte stream, with no queued lookahead, so cancellation is observable. */
function streamed(body: string, headers?: HeadersInit) {
  const bytes = new TextEncoder().encode(body)
  let delivered = 0
  const cancelled = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (delivered === bytes.length) { controller.close(); return }
      const end = Math.min(delivered + 65536, bytes.length)
      controller.enqueue(bytes.subarray(delivered, end))
      delivered = end
    },
    cancel: cancelled,
  }, { highWaterMark: 0 })
  return { response: new Response(stream, { headers }), cancelled, get delivered() { return delivered }, bytes: bytes.length }
}

describe('bounded chain response bodies', () => {
  it.each(CASES)('rejects and cancels oversized $args.family replies before consuming the whole stream', async ({ args, body }) => {
    const source = streamed(body.padEnd(2 * LIMIT, ' '), { 'content-length': '1' })
    await expect(getBalance(args, { fetch: async () => source.response })).rejects.toThrow(/response too large/i)
    expect(source.cancelled).toHaveBeenCalledTimes(1)
    expect(source.delivered).toBeLessThan(source.bytes)
    expect(source.response.body!.locked).toBe(false)
  })

  it.each(CASES)('accepts an exact 1 MiB $args.family reply without truncation', async ({ args, body, balance }) => {
    const source = streamed(body.padEnd(LIMIT, ' '))
    expect(await getBalance(args, { fetch: async () => source.response })).toMatchObject({ raw_balance: balance })
    expect(source.delivered).toBe(LIMIT)
    expect(source.cancelled).not.toHaveBeenCalled()
    expect(source.response.body!.locked).toBe(false)
  })

  it('counts UTF-8 bytes rather than decoded characters', async () => {
    const source = streamed(JSON.stringify({ result: '0x1', padding: 'é'.repeat(LIMIT) }))
    await expect(getBalance(EVM, { fetch: async () => source.response })).rejects.toThrow(/response too large/i)
    expect(source.cancelled).toHaveBeenCalledTimes(1)
    expect(source.delivered).toBeLessThan(source.bytes)
  })

  it('also bounds bitcoin tip-height text, not only JSON replies', async () => {
    const source = streamed('100'.padEnd(2 * LIMIT, ' '))
    await expect(getTxStatus({ family: 'bitcoin', network: 'testnet', tx_hash: 'ab'.repeat(32) }, {
      fetch: async url => String(url).endsWith('/blocks/tip/height') ? source.response : new Response(JSON.stringify({ confirmed: true, block_height: 100 })),
    })).rejects.toThrow(/response too large/i)
    expect(source.cancelled).toHaveBeenCalledTimes(1)
    expect(source.delivered).toBeLessThan(source.bytes)
  })

  it('keeps oversized metadata refusal explicit rather than guessing token units', async () => {
    const sources: ReturnType<typeof streamed>[] = []
    await expect(resolveToken(1, EVM.address, { fetch: async () => {
      const source = streamed(JSON.stringify({ result: '0x' + '0'.repeat(64) }).padEnd(2 * LIMIT, ' '))
      sources.push(source)
      return source.response
    } })).rejects.toThrow(/response too large/i)
    expect(sources).toHaveLength(2)
    for (const source of sources) expect(source.cancelled).toHaveBeenCalledTimes(1)
  })

  it.each([EVM, BITCOIN, CHIA])('refuses interrupted $family bodies without leaking provider details or leaving the reader locked', async args => {
    let pulls = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{'))
        else controller.error(new Error('https://operator.example/SECRET'))
      },
    }, { highWaterMark: 0 }))
    const result = getBalance(args, { fetch: async () => response })
    await expect(result).rejects.toThrow()
    await expect(result).rejects.not.toThrow('SECRET')
    expect(response.body!.locked).toBe(false)
  })

  it.each([EVM, BITCOIN])('cancels rejected $family HTTP response bodies', async args => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }), { status: 503 })
    await expect(getBalance(args, { fetch: async () => response })).rejects.toThrow()
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('cancels a bitcoin 404 body while retaining the unknown status', async () => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }), { status: 404 })
    expect(await getTxStatus({ family: 'bitcoin', network: 'testnet', tx_hash: 'ab'.repeat(32) }, { fetch: async () => response })).toMatchObject({ status: 'unknown', confirmations: 0 })
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
})

describe('bounded Chia coin records', () => {
  it('refuses more than 10000 records before processing any, never returning a partial balance', async () => {
    const body = JSON.stringify({ success: true, coin_records: Array.from({ length: 10001 }, () => ({})) })
    expect(new TextEncoder().encode(body).length).toBeLessThan(LIMIT)
    await expect(getBalance(CHIA, { fetch: async () => new Response(body) })).rejects.toThrow(/too many coin records.*10000/i)
  })

  it('allows the exact record ceiling for compact spent records', async () => {
    const body = JSON.stringify({ success: true, coin_records: Array.from({ length: 10000 }, () => ({ spent: true })) })
    expect(await getBalance(CHIA, { fetch: async () => new Response(body) })).toMatchObject({ raw_balance: '0' })
  })
})
