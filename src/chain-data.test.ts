import { describe, it, expect, vi } from 'vitest'
import { abiUint, buildTokenTransfer, decimalUnits, evmRpc, resolveToken, rpcUrlsFromJson, DEFAULT_RPC_URLS } from './chain-data.js'
import { TOKENS } from './tokens.js'
const ADDRESS = '0x' + '1'.repeat(40)
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0')

describe('chain data trust boundaries', () => {
  it('covers every configured web chain with keyless defaults', () => {
    expect(Object.keys(DEFAULT_RPC_URLS).map(Number).sort((a, b) => a - b)).toEqual([1, 10, 137, 8453, 42161, 80002, 84532, 421614, 11155111, 11155420])
    for (const url of Object.values(DEFAULT_RPC_URLS)) expect(new URL(url).search).toBe('')
  })
  it('uses an operator RPC override, never a URL supplied as a token', async () => {
    const fetcher = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ result: word(1n) })))
    await evmRpc(1, 'eth_call', [], { rpcUrls: { 1: 'https://operator.example/rpc' }, fetch: fetcher })
    expect(fetcher.mock.calls[0][0]).toBe('https://operator.example/rpc')
    await expect(resolveToken(1, 'https://attacker.example', { fetch: fetcher })).rejects.toThrow('pass the contract address')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each(['null', '[]', '{"1":"file:///etc/passwd"}', '{"chain":"https://rpc.example"}', '{'])('refuses bad RPC maps: %s', input => {
    expect(() => rpcUrlsFromJson(input)).toThrow('invalid RPC URL map')
  })
  it.each(['0', '-1', '+1', '.1', '1.', '01', '1e2', ' 1', 'NaN'])('refuses unsafe amount %s', amount => {
    expect(() => decimalUnits(amount, 6)).toThrow()
  })
  it('never rounds excess precision, even zero digits, and bounds uint256', () => {
    expect(() => decimalUnits('1.0000000', 6)).toThrow('fraction')
    expect(() => decimalUnits((2n ** 256n).toString(), 0)).toThrow('uint256')
    expect(decimalUnits((2n ** 256n - 1n).toString(), 0)).toBe((2n ** 256n - 1n).toString())
    expect(decimalUnits('0.000001', 6)).toBe('1')
  })
  it('keeps listed token identity chain-scoped', async () => {
    const fetcher = vi.fn()
    expect((await resolveToken(8453, 'USDC', { fetch: fetcher }))?.address).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    expect(fetcher).not.toHaveBeenCalled()
    expect(new Set(TOKENS.map(t => t.chain_id + ':' + t.address)).size).toBe(TOKENS.length)
  })
  it('fails explicit RPC errors without leaking credentials', async () => {
    const fetcher = vi.fn(async () => { throw new Error('https://rpc.example/SECRET') })
    await expect(evmRpc(1, 'eth_getBalance', [], { fetch: fetcher })).rejects.toThrow('chain 1 RPC read failed')
    await expect(evmRpc(999999, 'eth_getBalance', [], { fetch: fetcher })).rejects.toThrow('no RPC configured')
  })
  it.each(['0x', '0x00', '0xzz', '0x' + 'f'.repeat(66)])('rejects malformed metadata uint256 %s', raw => {
    expect(() => abiUint(raw)).toThrow()
  })
  it('refuses failed, oversized or invalid metadata rather than guessing decimals', async () => {
    for (const result of [word(256n), '0x', '0x' + 'a'.repeat(2048)]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ result })))
      await expect(buildTokenTransfer({ chain_id: 1, to: ADDRESS, token: ADDRESS, amount: '1' }, { fetch: fetcher })).rejects.toThrow('metadata unavailable')
    }
  })
})
