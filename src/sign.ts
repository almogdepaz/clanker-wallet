import { InvalidTxError } from './validate.js'
import type { SignPayload, SignTypedData } from './types.js'

/** Compact JSON UTF-8 bytes of message / typed_data, before encryption and base64. */
export const MAX_SIGN_PAYLOAD_BYTES = 32768
/** Includes context and authentication: leaves >10 KiB for encryption, base64 and relay framing. */
export const MAX_SIGN_REQUEST_BYTES = 40000
export const SIGN_CHAIN_IDS = [1, 11155111, 8453, 84532, 42161, 421614, 10, 11155420, 137, 80002] as const
export const isEoaSignature = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value)

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Reject values JSON would silently omit or change; return a detached, wire-exact snapshot. */
function snapshot(value: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' || (typeof v === 'number' && !Number.isFinite(v))) throw new Error()
      return v
    })
  } catch { throw new InvalidTxError('sign', 'payload must be JSON data') }
  if (json === undefined) throw new InvalidTxError('sign', 'payload must be JSON data')
  if (new TextEncoder().encode(json).length > MAX_SIGN_PAYLOAD_BYTES) throw new InvalidTxError('sign', `payload exceeds ${MAX_SIGN_PAYLOAD_BYTES} compact JSON bytes`)
  return JSON.parse(json)
}

export function validateSign(chainId: unknown, input: unknown): { chain_id: number; sign: SignPayload } {
  if (typeof chainId !== 'number' || !(SIGN_CHAIN_IDS as readonly number[]).includes(chainId)) throw new InvalidTxError('chain_id', 'must be a supported EVM chain id')
  if (!object(input)) throw new InvalidTxError('sign', 'must be a signature request object')
  if (input.method === 'personal_sign') {
    if (typeof input.message !== 'string' || (input.message.startsWith('0x') && !/^0x(?:[0-9a-fA-F]{2})*$/.test(input.message))) throw new InvalidTxError('message', 'must be UTF-8 text or 0x-prefixed complete hex bytes')
    return { chain_id: chainId, sign: { method: input.method, message: snapshot(input.message) as string } }
  }
  if (input.method !== 'eth_signTypedData_v4') throw new InvalidTxError('sign', 'unsupported method; eth_sign is never available')
  const data = snapshot(input.typed_data)
  if (!object(data) || !object(data.domain) || !object(data.types) || !object(data.message) || typeof data.primaryType !== 'string' || !Object.hasOwn(data.types, data.primaryType) || !Array.isArray(data.types[data.primaryType]) || !Array.isArray(data.types.EIP712Domain)) throw new InvalidTxError('typed_data', 'must be a parsed { domain, types, primaryType, message } object with EIP712Domain and primaryType in types')
  if (data.domain.chainId !== undefined) {
    try {
      const chain = data.domain.chainId
      if ((typeof chain !== 'string' && typeof chain !== 'number') || (typeof chain === 'number' && !Number.isSafeInteger(chain)) || BigInt(chain) !== BigInt(chainId)) throw new Error()
    } catch { throw new InvalidTxError('typed_data', 'domain.chainId must equal chain_id') }
  }
  return { chain_id: chainId, sign: { method: input.method, typed_data: data as unknown as SignTypedData } }
}

export function checkSignRequestSize(request: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(request)).length > MAX_SIGN_REQUEST_BYTES) throw new InvalidTxError('sign', `request including context exceeds ${MAX_SIGN_REQUEST_BYTES} bytes`)
}
