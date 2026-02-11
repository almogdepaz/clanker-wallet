/**
 * Simple ETH transfer example.
 *
 * Usage:
 *   PAIRING_JSON='{"version":1,...}' npx tsx examples/simple-transfer.ts
 */

import { ClankerWallet } from '../src/index'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const KEY_FILE = '.agent-key'

// restore or create agent identity
const secretKey = existsSync(KEY_FILE)
  ? new Uint8Array(readFileSync(KEY_FILE))
  : undefined

const wallet = new ClankerWallet({
  agentName: 'simple-transfer-bot',
  secretKey,
})

// persist identity for next run
if (!secretKey) writeFileSync(KEY_FILE, wallet.secretKey)

console.log(`agent id: ${wallet.agentId}`)

// pair with human (paste pairing JSON from web app QR code)
const pairingJson = process.env.PAIRING_JSON
if (!pairingJson) {
  console.error('set PAIRING_JSON env var with the pairing data from the web app')
  process.exit(1)
}

const pairing = wallet.pair(pairingJson)
console.log(`paired with wallet ${pairing.wallet} via ${pairing.relay}`)

// request a simple ETH transfer
try {
  const txHash = await wallet.requestTx({
    chain_id: 1,
    transaction: {
      to: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // vitalik.eth
      value: '1000000000000000', // 0.001 ETH
      data: '0x',
    },
    context: {
      reason: 'Send 0.001 ETH to vitalik.eth',
      urgency: 'low',
      expected_outcome: 'Simple transfer, no contract interaction',
    },
    timeout_ms: 120_000, // 2 minute timeout
  })

  console.log(`approved! tx hash: ${txHash}`)
} catch (err) {
  console.error(`request failed:`, err)
}
