/**
 * Uniswap V2 token swap example.
 * Demonstrates sending calldata that the web app will decode and display.
 *
 * Usage:
 *   PAIRING_JSON='{"version":1,...}' npx tsx examples/uniswap-swap.ts
 */

import { ClankerWallet } from '../src/index'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const KEY_FILE = '.agent-key'

const secretKey = existsSync(KEY_FILE)
  ? new Uint8Array(readFileSync(KEY_FILE))
  : undefined

const wallet = new ClankerWallet({
  agentName: 'swap-bot',
  secretKey,
})

if (!secretKey) writeFileSync(KEY_FILE, wallet.secretKey)

const pairingJson = process.env.PAIRING_JSON
if (!pairingJson) {
  console.error('set PAIRING_JSON env var')
  process.exit(1)
}

wallet.pair(pairingJson)
console.log(`agent ${wallet.agentId} paired`)

// Uniswap V2 Router: swapExactETHForTokens
// Swaps 0.01 ETH for USDC via WETH→USDC path
const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

// encode swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)
// selector: 0x7ff36ab5
const deadline = Math.floor(Date.now() / 1000) + 1200 // 20 minutes
const amountOutMin = 0n // accept any amount (DON'T do this in production!)

// ABI-encode the call (simplified — in production use viem's encodeFunctionData)
function encodePacked(...args: string[]): string {
  return args.join('')
}

function padUint256(val: bigint): string {
  return val.toString(16).padStart(64, '0')
}

function padAddress(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, '0')
}

const calldata = encodePacked(
  '0x7ff36ab5', // swapExactETHForTokens selector
  padUint256(amountOutMin),                      // amountOutMin
  padUint256(128n),                              // offset to path array
  padAddress('0x0000000000000000000000000000000000000000'), // to (will be sender)
  padUint256(BigInt(deadline)),                   // deadline
  padUint256(2n),                                // path.length
  padAddress(WETH),                              // path[0]
  padAddress(USDC),                              // path[1]
)

try {
  const txHash = await wallet.requestTx({
    chain_id: 1,
    transaction: {
      to: UNISWAP_V2_ROUTER,
      value: '10000000000000000', // 0.01 ETH
      data: calldata,
    },
    context: {
      reason: 'Swap 0.01 ETH for USDC via Uniswap V2',
      urgency: 'medium',
      expected_outcome: 'Receive USDC tokens in exchange for ETH',
    },
  })

  console.log(`swap approved! tx: ${txHash}`)
} catch (err) {
  console.error(`swap failed:`, err)
}
