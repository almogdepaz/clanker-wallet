/**
 * Vercel AI SDK tool example for clanker-wallet.
 *
 * Gives an AI agent (using Vercel AI SDK) the ability to send
 * blockchain transactions via human-approved wallet.
 *
 * Usage:
 *   PAIRING_JSON='{"version":1,...}' OPENAI_API_KEY=sk-... npx tsx examples/vercel-ai-tool.ts
 */

import { ClankerWallet } from '../src/index'
import { tool } from 'ai'
import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const KEY_FILE = '.agent-key'

const secretKey = existsSync(KEY_FILE)
  ? new Uint8Array(readFileSync(KEY_FILE))
  : undefined

const wallet = new ClankerWallet({
  agentName: 'vercel-ai-agent',
  secretKey,
})

if (!secretKey) writeFileSync(KEY_FILE, wallet.secretKey)

const pairingJson = process.env.PAIRING_JSON
if (pairingJson) wallet.pair(pairingJson)

/**
 * Vercel AI SDK tool for sending blockchain transactions.
 */
export const sendTransaction = tool({
  description:
    'Send a blockchain transaction that requires human approval. ' +
    'Use for ETH/token transfers, smart contract calls, or DEX swaps. ' +
    'The human reviews and approves/rejects in a web app.',
  parameters: z.object({
    chainId: z
      .number()
      .describe('Chain ID (1=Ethereum, 137=Polygon, 8453=Base, 42161=Arbitrum)'),
    to: z.string().describe('Recipient or contract address'),
    value: z.string().default('0').describe('Value in wei'),
    data: z.string().default('0x').describe('Hex calldata for contract calls'),
    reason: z.string().describe('Human-readable reason for this transaction'),
  }),
  execute: async ({ chainId, to, value, data, reason }) => {
    try {
      const txHash = await wallet.requestTx({
        chain_id: chainId,
        transaction: { to, value, data },
        context: { reason, urgency: 'medium' },
        timeout_ms: 300_000,
      })
      return { status: 'approved', txHash }
    } catch (err: any) {
      return { status: 'failed', error: err.message }
    }
  },
})

// Example: use with Vercel AI SDK
// import { openai } from '@ai-sdk/openai'
// import { generateText } from 'ai'
//
// const result = await generateText({
//   model: openai('gpt-4'),
//   tools: { sendTransaction },
//   prompt: 'Send 0.01 ETH to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
// })

console.log('Vercel AI tool created:', sendTransaction.description)
