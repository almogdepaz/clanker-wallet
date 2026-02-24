import nacl from 'tweetnacl'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** generate a random x25519 keypair for the agent's identity */
export function generateKeypair(): nacl.BoxKeyPair {
  return nacl.box.keyPair()
}

/** restore keypair from a 32-byte secret key */
export function keypairFromSecret(secretKey: Uint8Array): nacl.BoxKeyPair {
  return nacl.box.keyPair.fromSecretKey(secretKey)
}

/** encrypt a message using nacl.box. returns base64(nonce + ciphertext). */
export function encryptMessage(
  message: string,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box(encoder.encode(message), nonce, recipientPublicKey, senderSecretKey)
  const combined = new Uint8Array(nonce.length + ciphertext.length)
  combined.set(nonce)
  combined.set(ciphertext, nonce.length)
  return bytesToBase64(combined)
}

/** decrypt a nacl.box message. payload = base64(nonce + ciphertext). */
export function decryptMessage(
  base64Payload: string,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): string | null {
  const raw = base64ToBytes(base64Payload)
  if (raw.length <= nacl.box.nonceLength) return null

  const nonce = raw.slice(0, nacl.box.nonceLength)
  const ciphertext = raw.slice(nacl.box.nonceLength)
  const plaintext = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey)
  if (!plaintext) return null

  return decoder.decode(plaintext)
}

/** hex-encode bytes (no 0x prefix) */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** hex string → Uint8Array (strips 0x prefix if present) */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** derive an Ed25519 signing keypair from a 32-byte seed */
export function signingKeypairFromSeed(seed: Uint8Array): nacl.SignKeyPair {
  return nacl.sign.keyPair.fromSeed(seed)
}

/** sign a message string with an Ed25519 secret key. returns base64(signature). */
export function signMessage(message: string, signingSecretKey: Uint8Array): string {
  const signature = nacl.sign.detached(encoder.encode(message), signingSecretKey)
  return bytesToBase64(signature)
}

/** verify a detached Ed25519 signature. signature is base64-encoded. */
export function verifySignature(
  message: string,
  base64Signature: string,
  signingPublicKey: Uint8Array,
): boolean {
  const signature = base64ToBytes(base64Signature)
  return nacl.sign.detached.verify(encoder.encode(message), signature, signingPublicKey)
}

/** base64 string → Uint8Array */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** Uint8Array → base64 string */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
