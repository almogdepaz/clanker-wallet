/**
 * LangChain custom tool example for clanker-wallet.
 *
 * Gives a LangChain agent the ability to send blockchain transactions
 * via human-approved wallet.
 *
 * Usage:
 *   PAIRING_JSON='{"version":1,...}' OPENAI_API_KEY=sk-... npx tsx examples/langchain-tool.ts
 */

import { ClankerWallet } from '../src/index'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const KEY_FILE = '.agent-key'

const secretKey = existsSync(KEY_FILE)
  ? new Uint8Array(readFileSync(KEY_FILE))
  : undefined

const wallet = new ClankerWallet({
  agentName: 'langchain-agent',
  secretKey,
})

if (!secretKey) writeFileSync(KEY_FILE, wallet.secretKey)

const pairingJson = process.env.PAIRING_JSON
if (pairingJson) wallet.pair(pairingJson)

/**
 * LangChain tool that sends a blockchain transaction via clanker-wallet.
 * The transaction is proposed to a human who must approve it.
 */
export const sendTransactionTool = new DynamicStructuredTool({
  name: 'send_blockchain_transaction',
  description:
    'Send a blockchain transaction that requires human approval. ' +
    'Use this to transfer ETH/tokens, interact with smart contracts, or perform swaps. ' +
    'The human will review and approve/reject the transaction.',
  schema: z.object({
    chainId: z
      .number()
      .describe('Chain ID (1=Ethereum, 137=Polygon, 8453=Base, 42161=Arbitrum, 10=Optimism)'),
    to: z.string().describe('Recipient or contract address (0x...)'),
    value: z
      .string()
      .default('0')
      .describe('Value in wei (1 ETH = 1000000000000000000). Default 0.'),
    data: z
      .string()
      .default('0x')
      .describe('Hex-encoded calldata for contract interactions. Default 0x for simple transfers.'),
    reason: z.string().describe('Human-readable explanation of what this transaction does'),
  }),
  func: async ({ chainId, to, value, data, reason }) => {
    try {
      const txHash = await wallet.requestTx({
        chain_id: chainId,
        transaction: { to, value, data },
        context: { reason, urgency: 'medium' },
        timeout_ms: 300_000,
      })
      return `Transaction approved! Hash: ${txHash}`
    } catch (err: any) {
      return `Transaction failed: ${err.message}`
    }
  },
})

// Example: use with a LangChain agent
// import { ChatOpenAI } from '@langchain/openai'
// import { AgentExecutor, createOpenAIToolsAgent } from 'langchain/agents'
//
// const llm = new ChatOpenAI({ model: 'gpt-4' })
// const agent = await createOpenAIToolsAgent({ llm, tools: [sendTransactionTool], prompt })
// const executor = new AgentExecutor({ agent, tools: [sendTransactionTool] })
// await executor.invoke({ input: 'Send 0.01 ETH to vitalik.eth' })

console.log('LangChain tool created:', sendTransactionTool.name)
console.log('Add this tool to your LangChain agent to enable blockchain transactions.')
