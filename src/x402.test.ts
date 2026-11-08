import { describe, it, expect, vi } from 'vitest'
import * as x402 from './x402.js'

const url = 'https://service.example/paid'
const asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const payer = '0x' + '1'.repeat(40)
const requirement = { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset, payTo: '0x' + '2'.repeat(40), maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }
const required = (accepts: unknown[] = [requirement], rest: Record<string, unknown> = {}) => ({ x402Version: 2, resource: { url, description: 'paid data' }, accepts, ...rest })
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
const reply = (v = required()) => new Response('{}', { status: 402, headers: { 'payment-required': encode(v) } })
const prepare = async (v = required(), max = '0.01') => x402.prepareX402(await x402.fetchX402(x402.validateX402Fetch({ url }), { fetch: async () => reply(v) }), url, max, payer)

describe('x402 bounded HTTP and authorization', () => {
  it('validates structured context caps, addresses and required text fields', () => {
    const context = { resource_url: url, network: 'eip155:8453', pay_to: requirement.payTo, asset, amount: '10000' }
    expect(x402.x402ContextError(context)).toBeUndefined()
    for (const change of [{ amount: '1.5' }, { asset: 'bad' }, { pay_to: 42 }, { resource_url: 'http://private/' }, { description: 'a'.repeat(1025) }, { service_name: 2 }, { network: 'solana:mainnet' }, { server_resource_url: 2 }]) expect(x402.x402ContextError({ ...context, ...change })).toMatch(/x402/)
    expect(x402.x402ContextError({})).toMatch(/x402/)
  })
  it('selects the first supported exact EVM eip3009 offer, uses trusted decimals and echoes wire data', async () => {
    const v = required([{ ...requirement, scheme: 'upto' }, { ...requirement, network: 'solana:foo' }, requirement], { extensions: { custom: { info: { text: 'é' }, schema: {} } } })
    const result = await prepare(v)
    expect(result.chain_id).toBe(8453)
    expect(result.typed_data).toMatchObject({ domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: asset }, primaryType: 'TransferWithAuthorization', message: { from: payer, to: requirement.payTo, value: '10000' } })
    expect(result.typed_data.message.nonce).toMatch(/^0x[0-9a-f]{64}$/)
    expect(result.context).toMatchObject({ resource_url: url, network: 'eip155:8453', asset, amount: '10000' })
    const payment = JSON.parse(Buffer.from(x402.x402PaymentHeader(result, '0x' + 'ab'.repeat(65)), 'base64').toString())
    expect(payment).toMatchObject({ x402Version: 2, resource: v.resource, accepted: requirement, extensions: { custom: { info: { text: 'é' }, schema: {} } }, payload: { authorization: result.typed_data.message } })
    expect((await prepare()).typed_data.message.nonce).not.toBe(result.typed_data.message.nonce)
  })
  it('uses the verified reference convention and a ten-minute approval window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(2_000_000_000_000)
      const result = await prepare()
      expect(result.typed_data.message.validAfter).toBe('1999999400')
      expect(result.typed_data.message.validBefore).toBe('2000000660')
      expect(result.expires_at).toBe(2_000_000_600_000)
      vi.setSystemTime(2_000_000_660_000)
      const fetch = vi.fn()
      await expect(x402.retryX402({ url, method: 'GET', headers: {} }, result, '0x' + 'ab'.repeat(65), { fetch })).rejects.toThrow('authorization expired')
      expect(fetch).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('accepts spec-valid positive integer strings and empty EIP-712 domain strings without guessing values', async () => {
    const result = await prepare(required([{ ...requirement, amount: '00010000', extra: { name: '', version: '' } }]))
    expect(result.typed_data).toMatchObject({ domain: { name: '', version: '' }, message: { value: '00010000' } })
  })
  it('reads on-chain decimals for unlisted assets and ignores server precision claims', async () => {
    const asset = '0x' + '3'.repeat(40)
    const response = await x402.fetchX402(x402.validateX402Fetch({ url }), { fetch: async () => reply(required([{ ...requirement, asset, amount: '100', extra: { name: 'Token', version: '1', decimals: 6 } }])) })
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body))
      expect(call.params[0].to).toBe(asset)
      const result = call.params[0].data === '0x313ce567' ? '0x' + '2'.padStart(64, '0') : '0x' + Buffer.from('TKN').toString('hex').padEnd(64, '0')
      return new Response(JSON.stringify({ result }))
    })
    await expect(x402.prepareX402(response, url, '0.99', payer, { fetch })).rejects.toThrow('max_amount')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await x402.prepareX402(response, url, '1', payer, { fetch })).toMatchObject({ typed_data: { message: { value: '100' } } })
  })
  it('enforces the HTTP deadline during stalled body reads and cancels the stream', async () => {
    vi.useFakeTimers()
    try {
      const cancel = vi.fn()
      const response = new Response(new ReadableStream({ cancel }))
      const pending = x402.fetchX402(x402.validateX402Fetch({ url }), { fetch: async () => response })
      const assertion = expect(pending).rejects.toThrow('HTTP request timed out')
      await vi.advanceTimersByTimeAsync(30000)
      await assertion
      expect(cancel).toHaveBeenCalledOnce()
      expect(response.body!.locked).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('accepts an exact 1 MiB response and reports complete byte count with capped text', async () => {
    const response = await x402.fetchX402(x402.validateX402Fetch({ url }), { fetch: async () => new Response('a'.repeat(1048576), { headers: { 'content-type': 'text/plain' } }) })
    expect(x402.x402HttpResult(response, false)).toMatchObject({ bytes: 1048576, truncated: true })
  })
  it('refuses over-cap payments without constructing a signature request', async () => {
    await expect(prepare(required(), '0.009')).rejects.toThrow(/max_amount/)
  })
  it.each([{ scheme: 'upto' }, { network: 'eip155:999' }, { extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }, { extra: { name: 'USDC', version: '2', paymentFlow: 'escrow' } }, { amount: '0' }, { amount: '-1' }, { payTo: 'bad' }, { extra: {} }, { maxTimeoutSeconds: -1 }])('refuses unsupported offers: %s', async change => {
    await expect(prepare(required([{ ...requirement, ...change }]))).rejects.toMatchObject({ offered: [expect.objectContaining({ scheme: expect.anything(), network: expect.anything(), amount: expect.anything() })] })
  })
  it('bounds echoed resource/extensions and refuses malformed v2 instead of falling back', async () => {
    await expect(prepare(required([requirement], { extensions: { oversized: 'a'.repeat(9000) } }))).rejects.toThrow(/echo/)
    await expect(x402.prepareX402(await x402.fetchX402({ url, method: 'GET', headers: {} }, { fetch: async () => new Response(JSON.stringify({ x402Version: 1, accepts: [] }), { status: 402, headers: { 'payment-required': 'invalid' } }) }), url, '1', payer)).rejects.toThrow(/payment-required/i)
  })
  it.each(['http://service.example', 'https://user:password@service.example', 'file:///tmp/a'])('refuses unsafe URL %s', url => expect(() => x402.validateX402Fetch({ url })).toThrow())
  it.each(['host', 'content-length', 'connection', 'transfer-encoding', 'payment-signature', 'X-PAYMENT', 'proxy-authorization', 'proxy-connection'])('refuses reserved header %s', name => expect(() => x402.validateX402Fetch({ url, headers: { [name]: 'x' } })).toThrow(/header/))
  it('preserves valid header names even when they match object prototype properties', async () => {
    const input = x402.validateX402Fetch({ url, headers: JSON.parse('{"__proto__":"safe","constructor":"also safe"}') })
    expect(Object.hasOwn(input.headers, '__proto__')).toBe(true)
    await x402.fetchX402(input, { fetch: async (_url, init) => {
      expect(new Headers(init?.headers).get('__proto__')).toBe('safe')
      return new Response('ok')
    } })
  })
  it('bounds input headers/body, method, and total bytes', () => {
    for (const args of [{ headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => ['x-' + i, 'a'])) }, { headers: { x: 'é'.repeat(4096) } }, { body: 'x'.repeat(16385), method: 'POST' }, { method: 'OPTIONS' }, { body: 'a' }]) expect(() => x402.validateX402Fetch({ url, ...args })).toThrow()
  })
  it('never follows redirects and preserves location, caps text and omits binary body', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('a'.repeat(20000), { status: 302, headers: { location: 'http://private/', 'content-type': 'text/plain' } }))
    const response = await x402.fetchX402(x402.validateX402Fetch({ url }), { fetch })
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) })
    expect(x402.x402HttpResult(response, false)).toMatchObject({ status: 302, location: 'http://private/', paid: false, truncated: true })
    expect(x402.x402HttpResult(response, false).body!.length).toBeLessThan(20000)
    expect(x402.x402HttpResult(await x402.fetchX402(x402.validateX402Fetch({ url }), { fetch: async () => new Response(new Uint8Array([0, 1, 255]), { headers: { 'content-type': 'application/octet-stream' } }) }), false)).toEqual({ status: 200, content_type: 'application/octet-stream', bytes: 3, paid: false })
  })
  it('caps returned UTF-8 without expanding a split multibyte character', async () => {
    const result = x402.x402HttpResult(await x402.fetchX402(x402.validateX402Fetch({ url }), { fetch: async () => new Response('a' + '🌍'.repeat(3000), { headers: { 'content-type': 'text/plain' } }) }), false)
    expect(new TextEncoder().encode(result.body).length).toBeLessThanOrEqual(8192)
    expect(result.body).not.toContain('�')
  })
  it('cancels oversized streams and sanitizes network/body errors', async () => {
    let delivered = 0
    const cancel = vi.fn()
    const stream = new ReadableStream({ pull(c) { delivered += 65536; c.enqueue(new Uint8Array(65536)) }, cancel }, { highWaterMark: 0 })
    await expect(x402.fetchX402(x402.validateX402Fetch({ url }), { fetch: async () => new Response(stream) })).rejects.toThrow(/too large/)
    expect(cancel).toHaveBeenCalledOnce()
    expect(delivered).toBeLessThan(2 * 1024 * 1024)
    await expect(x402.fetchX402(x402.validateX402Fetch({ url }), { fetch: async () => { throw new Error('SECRET') } })).rejects.toThrow('HTTP request failed')
  })
  it('decodes settlement pending and second-402 failures, never hiding uncertainty', async () => {
    const p = await prepare()
    for (const [status, settlement] of [[200, { success: true, transaction: '0xabc', network: requirement.network }], [402, { success: false, transaction: '', network: requirement.network, errorReason: 'insufficient_funds' }], [202, { success: false, transaction: '0xabc', network: requirement.network, errorReason: 'settlement_pending' }]] as const) {
      const result = await x402.retryX402({ url, method: 'GET', headers: {} }, p, '0x' + 'ab'.repeat(65), { fetch: async () => new Response('data', { status, headers: { 'content-type': 'text/plain', 'payment-response': encode(settlement) } }) })
      expect(result).toMatchObject({ status, paid: true, settlement })
      if (status === 402) expect(result.error).toMatch(/payment failed.*insufficient_funds/)
      if (status === 202) expect(result.pending).toBe(true)
    }
  })
})
