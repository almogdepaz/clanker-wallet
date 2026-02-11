/**
 * Scheduled task example — agent runs on a timer and requests
 * transactions periodically (e.g. DCA, rebalancing, yield harvesting).
 *
 * Usage:
 *   PAIRING_JSON='{"version":1,...}' npx tsx examples/scheduled-task.ts
 */

import { ClankerWallet } from '../src/index'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const KEY_FILE = '.agent-key'
const INTERVAL_MS = 60_000 // check every minute
const TX_TIMEOUT_MS = 300_000 // 5 minute approval window

const secretKey = existsSync(KEY_FILE)
  ? new Uint8Array(readFileSync(KEY_FILE))
  : undefined

const wallet = new ClankerWallet({
  agentName: 'dca-bot',
  secretKey,
})

if (!secretKey) writeFileSync(KEY_FILE, wallet.secretKey)

const pairingJson = process.env.PAIRING_JSON
if (!pairingJson) {
  console.error('set PAIRING_JSON env var')
  process.exit(1)
}

wallet.pair(pairingJson)
console.log(`agent ${wallet.agentId} paired — starting DCA loop`)

// simulated price check — replace with real oracle/API
function shouldBuy(): boolean {
  return Math.random() > 0.7 // 30% chance each interval
}

async function dcaIteration(iteration: number) {
  console.log(`[${new Date().toISOString()}] iteration ${iteration} — checking conditions...`)

  if (!shouldBuy()) {
    console.log('  conditions not met, skipping')
    return
  }

  console.log('  conditions met! requesting buy tx...')

  try {
    const txHash = await wallet.requestTx({
      chain_id: 1,
      transaction: {
        to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
        value: '0',
        // transfer(address,uint256) — buy 100 USDC worth
        data: '0xa9059cbb' +
          '000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045' +
          '0000000000000000000000000000000000000000000000000000000005f5e100',
      },
      context: {
        reason: `DCA iteration ${iteration} — scheduled USDC purchase`,
        urgency: 'low',
        expected_outcome: 'Transfer 100 USDC as part of dollar-cost averaging strategy',
      },
      timeout_ms: TX_TIMEOUT_MS,
    })

    console.log(`  approved! tx: ${txHash}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('timed out')) {
      console.log('  timed out waiting for approval — will retry next interval')
    } else if (msg.includes('rejected')) {
      console.log('  human rejected — skipping this iteration')
    } else {
      console.error('  error:', msg)
    }
  }
}

// run the loop
let iteration = 0
async function loop() {
  while (true) {
    await dcaIteration(++iteration)
    await new Promise(r => setTimeout(r, INTERVAL_MS))
  }
}

loop().catch(console.error)
