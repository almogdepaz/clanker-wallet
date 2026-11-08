import { decimalUnits, resolveToken, type ChainDataOptions } from './chain-data.js'
import { base64ToBytes, bytesToBase64, toHex } from './crypto.js'
import { isChecksumAddress } from './validate.js'
import { SIGN_CHAIN_IDS, isEoaSignature } from './sign.js'
import type { SignTypedData, X402Context } from './types.js'

const encoder = new TextEncoder()
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const bytes = (v: string) => encoder.encode(v).length
const MAX_RESPONSE = 1024 * 1024
const MAX_ECHO = 8192
const MAX_RESULT_BODY = 8192
export const X402_APPROVAL_MS = 600_000

export class X402Error extends Error {
  constructor(message: string, readonly offered?: { scheme: unknown; network: unknown; transfer_method: unknown; amount: unknown }[]) { super(message) }
}
export interface X402FetchInput { url: string; method: string; headers: Record<string, string>; body?: string }
export interface X402Requirement extends Record<string, unknown> {
  scheme: 'exact'; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number
  extra: Record<string, unknown> & { name: string; version: string }
}
export interface X402Payment {
  version: 2
  accepted: X402Requirement
  resource: Record<string, unknown>
  extensions?: Record<string, unknown>
  chain_id: number
  typed_data: SignTypedData
  context: X402Context
  expires_at: number
}
export interface X402HttpResponse { status: number; content_type: string; text?: string; bytes: number; location?: string; payment_required?: string; payment_response?: string }
export interface X402HttpResult {
  status: number; content_type: string; body?: string; bytes: number; paid: boolean; truncated?: boolean; location?: string
  settlement?: { success: boolean; transaction: string; network: string; payer?: string; errorReason?: string }
  error?: string; pending?: boolean
}

/** Structured context is inert metadata, bounded independently of the complete signed-request budget. */
export function x402ContextError(value: unknown): string | undefined {
  if (!object(value)) return 'invalid x402 context: expected an object'
  const caps = { resource_url: 2048, server_resource_url: 2048, description: 1024, service_name: 32, network: 128, pay_to: 42, asset: 42, amount: 78 }
  for (const [key, cap] of Object.entries(caps)) {
    if (value[key] === undefined && ['server_resource_url', 'description', 'service_name'].includes(key)) continue
    if (typeof value[key] !== 'string' || (value[key] as string).length > cap || /[\u0000-\u001f\u007f]/.test(value[key] as string)) return `invalid x402 context field: ${key}`
  }
  try { if (new URL(value.resource_url as string).protocol !== 'https:') throw new Error() } catch { return 'invalid x402 resource_url' }
  if (!/^eip155:[1-9][0-9]*$/.test(value.network as string) || !isChecksumAddress(value.pay_to as string) || !isChecksumAddress(value.asset as string) || !/^[1-9][0-9]{0,77}$/.test(value.amount as string) || BigInt(value.amount as string) >= 2n ** 256n) return 'invalid x402 payment context'
}

/** Agent credentials must not reach a different origin via redirects or a caller-supplied payment header. */
export function validateX402Fetch(args: Record<string, unknown>): X402FetchInput {
  let url: URL
  try { url = new URL(typeof args.url === 'string' ? args.url : '') } catch { throw new X402Error('url must be an absolute HTTPS URL') }
  if (url.protocol !== 'https:' || url.username || url.password || bytes(url.href) > 2048) throw new X402Error('url must be HTTPS, without credentials, at most 2048 bytes')
  const method = args.method ?? 'GET'
  if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new X402Error('unsupported HTTP method')
  if (args.body !== undefined && (typeof args.body !== 'string' || bytes(args.body) > 16384 || method === 'GET')) throw new X402Error('body must be a string of at most 16384 bytes, and cannot accompany GET')
  const input = args.headers ?? {}
  if (!object(input) || Object.keys(input).length > 20) throw new X402Error('headers must be a string map with at most 20 entries')
  const headers: Record<string, string> = {}
  let size = 0
  const forbidden = new Set(['host', 'content-length', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'payment-signature', 'x-payment'])
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || forbidden.has(lower) || typeof value !== 'string' || /[\r\n\u0000]/.test(value) || Object.hasOwn(headers, lower)) throw new X402Error('invalid or reserved HTTP header')
    size += bytes(name) + bytes(value) + 4
    headers[lower] = value
  }
  if (size > 8192) throw new X402Error('headers exceed 8192 bytes')
  return { url: url.href, method, headers, ...(args.body !== undefined && { body: args.body as string }) }
}

/** A single bounded request, including streamed body reads under the same 30-second timeout. */
export async function fetchX402(input: X402FetchInput, options: ChainDataOptions = {}, paymentHeader?: string): Promise<X402HttpResponse> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  const timedOut = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new X402Error('HTTP request timed out')), { once: true }))
  // A fetch implementation can reject before any body read races the deadline.
  void timedOut.catch(() => {})
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await (options.fetch ?? globalThis.fetch)(input.url, { method: input.method, headers: { ...input.headers, ...(paymentHeader && { 'PAYMENT-SIGNATURE': paymentHeader }) }, ...(input.body !== undefined && { body: input.body }), redirect: 'manual', signal: abort.signal })
    const content_type = (response.headers.get('content-type') ?? '').slice(0, 256)
    const textual = /^(text\/|application\/(?:[\w.+-]*\+)?(?:json|xml)(?:;|$)|application\/(?:javascript|x-www-form-urlencoded)(?:;|$))/i.test(content_type)
    const decoder = new TextDecoder()
    let text = '', count = 0
    reader = response.body?.getReader()
    if (reader) {
      while (true) {
        const chunk = await Promise.race([reader.read(), timedOut])
        if (chunk.done) break
        count += chunk.value.byteLength
        if (count > MAX_RESPONSE) throw new X402Error('HTTP response too large: limit 1048576 bytes')
        if (textual) text += decoder.decode(chunk.value, { stream: true })
      }
    }
    if (textual) text += decoder.decode()
    return { status: response.status, content_type, bytes: count, ...(textual && { text }), ...(response.status >= 300 && response.status < 400 && response.headers.has('location') && { location: response.headers.get('location')!.slice(0, 2048) }), ...(response.headers.has('payment-required') && { payment_required: response.headers.get('payment-required')! }), ...(response.headers.has('payment-response') && { payment_response: response.headers.get('payment-response')! }) }
  } catch (err) {
    if (reader) { try { await reader.cancel() } catch { /* retain the sanitized original failure */ } }
    if (err instanceof X402Error) throw err
    throw new X402Error('HTTP request failed; no automatic retry')
  } finally { clearTimeout(timer); reader?.releaseLock() }
}

function decodeHeader(header: string, label: string): unknown {
  try {
    if (header.length > 32768 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) throw new Error()
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(header)))
  } catch { throw new X402Error(`invalid ${label} header`) }
}

/** Server claims never supply token precision. Keep the accepted entry and echo objects wire-exact. */
export async function prepareX402(response: X402HttpResponse, fetchedUrl: string, maxAmount: unknown, from: string, options: ChainDataOptions = {}): Promise<X402Payment> {
  if (response.payment_required === undefined) throw new X402Error('x402 v2 PAYMENT-REQUIRED header required; v1 is not supported')
  const required = decodeHeader(response.payment_required, 'PAYMENT-REQUIRED')
  if (!object(required) || required.x402Version !== 2 || !Array.isArray(required.accepts) || required.accepts.length > 50 || !object(required.resource) || typeof required.resource.url !== 'string' || (required.extensions !== undefined && !object(required.extensions))) throw new X402Error('invalid PAYMENT-REQUIRED schema')
  if (bytes(JSON.stringify({ resource: required.resource, extensions: required.extensions })) > MAX_ECHO) throw new X402Error('payment echo exceeds 8192 bytes')
  const offered = required.accepts.map((v: unknown) => {
    const r = object(v) ? v : {}
    const field = (v: unknown) => typeof v === 'string' ? v.slice(0, 128) : null
    return { scheme: field(r.scheme), network: field(r.network), transfer_method: object(r.extra) ? field(r.extra.assetTransferMethod) ?? 'eip3009' : 'eip3009', amount: field(r.amount) }
  })
  const selected = required.accepts.find((r: unknown) => {
    if (!object(r) || r.scheme !== 'exact' || typeof r.network !== 'string' || !/^eip155:[1-9][0-9]*$/.test(r.network) || !(SIGN_CHAIN_IDS as readonly number[]).includes(Number(r.network.slice(7)))) return false
    if (typeof r.asset !== 'string' || !isChecksumAddress(r.asset) || typeof r.payTo !== 'string' || !isChecksumAddress(r.payTo) || typeof r.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(r.amount) || BigInt(r.amount) >= 2n ** 256n) return false
    if (!Number.isSafeInteger(r.maxTimeoutSeconds) || (r.maxTimeoutSeconds as number) <= 0 || (r.maxTimeoutSeconds as number) > 86400 || !object(r.extra)) return false
    return (r.extra.assetTransferMethod === undefined || r.extra.assetTransferMethod === 'eip3009') && (r.extra.paymentFlow === undefined || r.extra.paymentFlow === 'authorization') && typeof r.extra.name === 'string' && !!r.extra.name && r.extra.name.length <= 128 && typeof r.extra.version === 'string' && !!r.extra.version && r.extra.version.length <= 32
  }) as X402Requirement | undefined
  if (!selected) throw new X402Error('no supported exact EVM eip3009 payment requirement', offered)
  if (bytes(JSON.stringify(selected)) > MAX_ECHO) throw new X402Error('accepted payment echo exceeds 8192 bytes')
  const chain_id = Number(selected.network.slice(7))
  const token = await resolveToken(chain_id, selected.asset, options)
  if (!token) throw new X402Error('payment requires a token contract')
  const max = decimalUnits(maxAmount, token.decimals)
  if (BigInt(selected.amount) > BigInt(max)) throw new X402Error('payment amount exceeds max_amount')
  if (!isChecksumAddress(from)) throw new X402Error('paired EVM wallet address is required')
  const created = Math.floor(Date.now() / 1000)
  const typed_data: SignTypedData = {
    domain: { name: selected.extra.name, version: selected.extra.version, chainId: chain_id, verifyingContract: selected.asset },
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    primaryType: 'TransferWithAuthorization',
    message: { from, to: selected.payTo, value: selected.amount, // now−600 follows the pinned official v1 client; v2 uses 0. The reference facilitator imposes no maxTimeoutSeconds-based upper bound.
    validAfter: String(Math.max(0, created - 600)), validBefore: String(created + 600 + selected.maxTimeoutSeconds), nonce: '0x' + toHex(crypto.getRandomValues(new Uint8Array(32))) },
  }
  const context: X402Context = { resource_url: fetchedUrl, network: selected.network, pay_to: selected.payTo, asset: selected.asset, amount: selected.amount }
  if (required.resource.url !== fetchedUrl) context.server_resource_url = required.resource.url.slice(0, 2048)
  for (const [source, target, cap] of [['description', 'description', 1024], ['serviceName', 'service_name', 32]] as const) {
    if (typeof required.resource[source] === 'string') context[target] = required.resource[source].slice(0, cap)
  }
  const contextError = x402ContextError(context)
  if (contextError) throw new X402Error(contextError)
  return { version: 2, accepted: selected, resource: required.resource, ...(required.extensions !== undefined && { extensions: required.extensions }), chain_id, typed_data, context, expires_at: (created + 600) * 1000 }
}

export function x402PaymentHeader(payment: X402Payment, signature: string): string {
  if (!isEoaSignature(signature)) throw new X402Error('payment requires a 65-byte signature')
  return bytesToBase64(encoder.encode(JSON.stringify({ x402Version: payment.version, resource: payment.resource, accepted: payment.accepted, payload: { signature, authorization: payment.typed_data.message }, ...(payment.extensions !== undefined && { extensions: payment.extensions }) })))
}

export function x402HttpResult(response: X402HttpResponse, paid: boolean): X402HttpResult {
  let body: string | undefined, truncated = false
  if (response.text !== undefined) {
    const data = encoder.encode(response.text)
    truncated = data.length > MAX_RESULT_BODY
    body = new TextDecoder().decode(data.subarray(0, MAX_RESULT_BODY))
  }
  const result: X402HttpResult = { status: response.status, content_type: response.content_type, bytes: response.bytes, paid, ...(body !== undefined && { body }), ...(truncated && { truncated }), ...(response.location !== undefined && { location: response.location }) }
  if (paid && response.payment_response !== undefined) {
    try {
      const v = decodeHeader(response.payment_response, 'PAYMENT-RESPONSE')
      if (!object(v) || typeof v.success !== 'boolean' || typeof v.transaction !== 'string' || v.transaction.length > 256 || typeof v.network !== 'string' || v.network.length > 128 || (v.payer !== undefined && (typeof v.payer !== 'string' || v.payer.length > 128)) || (v.errorReason !== undefined && (typeof v.errorReason !== 'string' || v.errorReason.length > 256))) throw new X402Error('invalid PAYMENT-RESPONSE schema')
      result.settlement = { success: v.success, transaction: v.transaction, network: v.network, ...(v.payer !== undefined && { payer: v.payer as string }), ...(v.errorReason !== undefined && { errorReason: v.errorReason as string }) }
      if (v.errorReason === 'settlement_pending') { result.pending = true; result.error = `settlement pending: ${v.transaction || 'missing transaction hash'}` }
      else if (!v.success) result.error = `payment failed: ${v.errorReason ?? 'unknown reason'}`
    } catch (err) { result.error = err instanceof X402Error ? err.message : 'invalid payment settlement' }
  }
  if (paid && response.status === 402) result.error = `payment failed: ${result.settlement?.errorReason ?? result.error ?? 'second 402'}; not retried`
  return result
}

/** Caller owns the exactly-once marker; network errors must never cause an automatic second attempt. */
export async function retryX402(input: X402FetchInput, payment: X402Payment, signature: string, options: ChainDataOptions = {}): Promise<X402HttpResult> {
  if (Math.floor(Date.now() / 1000) >= BigInt(String(payment.typed_data.message.validBefore))) throw new X402Error('authorization expired')
  return x402HttpResult(await fetchX402(input, options, x402PaymentHeader(payment, signature)), true)
}
