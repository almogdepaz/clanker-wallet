import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_WAIT_SECONDS, MCP_TOOLS, REQUEST_STATUSES } from './mcp.js'
import { validateTransfer, validateTx } from './validate.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// documented examples run on base sepolia
const EXAMPLE_CHAIN = 84532

// documented transfer examples run on the test networks
const EXAMPLE_TRANSFER_NETWORK = { bitcoin: 'testnet', chia: 'testnet11' } as const

/** every `clanker-wallet <command> --...` line in a doc (not usage lines), backslash continuations joined */
function cliExamples(text: string, command: 'tx' | 'send'): string[] {
  const joined = text.replace(/\\\r?\n\s*/g, ' ')
  return [...joined.matchAll(new RegExp(`clanker-wallet ${command} (--.*)`, 'g'))]
    .map((m) => m[1].split('`')[0].trim())
    // usage lines show placeholders: `send --btc <mainnet|testnet|signet>`
    .filter((example) => !example.includes('<'))
}

/** --flag value pairs; double-quoted values may contain spaces */
function flagsOf(command: string): Record<string, string> {
  const tokens = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
  const flags: Record<string, string> = {}
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].startsWith('--')) flags[tokens[i].slice(2)] = tokens[++i]
  }
  return flags
}

const CLI_DOCS = ['SKILL.md', 'README.md', 'llms-full.txt', 'bin/cli.js']
const SDK_DOCS = ['README.md', 'llms-full.txt', 'python/README.md']

describe('documented examples are runnable', () => {
  it.each(CLI_DOCS)('every cli tx example in %s passes validation on base sepolia', (doc) => {
    const examples = cliExamples(read(doc), 'tx')
    expect(examples.length).toBeGreaterThan(0)
    for (const command of examples) {
      const flags = flagsOf(command)
      expect(Number(flags.chain), command).toBe(EXAMPLE_CHAIN)
      expect(() => validateTx(Number(flags.chain), { to: flags.to, value: flags.value ?? '0', data: flags.data }), command)
        .not.toThrow()
    }
  })

  it.each(CLI_DOCS)('every cli send example in %s passes validation on a test network', (doc) => {
    const examples = cliExamples(read(doc), 'send')
    expect(examples.length).toBeGreaterThan(0)
    for (const command of examples) {
      const flags = flagsOf(command)
      const family = flags.btc !== undefined ? 'bitcoin' : 'chia'
      const network = flags.btc ?? flags.xch
      expect(network, command).toBe(EXAMPLE_TRANSFER_NETWORK[family])
      const transfer = family === 'bitcoin'
        ? { asset: 'btc' as const, to: flags.to, amount: flags.sats }
        : { asset: 'xch' as const, to: flags.to, amount: flags.mojos, fee: flags['fee-mojos'] }
      expect(() => validateTransfer(family, network, transfer), command).not.toThrow()
    }
  })

  it.each(SDK_DOCS)('every sdk example in %s uses a real address and base sepolia or a test network', (doc) => {
    const text = read(doc)
    const chains = [...text.matchAll(/chain_id[:=]\s*(\d+)/g)].map((m) => Number(m[1]))
    const recipients = [...text.matchAll(/\bto[:=]\s*['"]([^'"]*)['"]/g)].map((m) => m[1])
    const networks = [...text.matchAll(/chain_network[:=]\s*['"]([^'"]*)['"]/g)].map((m) => m[1])
    expect(chains.length).toBeGreaterThan(0)
    expect(recipients.length).toBeGreaterThan(0)
    expect(networks.length, 'documents requestTransfer/request_transfer').toBeGreaterThan(0)
    for (const chain of chains) expect(chain).toBe(EXAMPLE_CHAIN)
    for (const network of networks) expect(Object.values(EXAMPLE_TRANSFER_NETWORK)).toContain(network)
    for (const to of recipients) {
      // evm recipients are 0x addresses; the rest are transfer recipients on the documented test networks
      if (to.startsWith('0x')) expect(() => validateTx(EXAMPLE_CHAIN, { to, value: '0' }), to).not.toThrow()
      else if (to.startsWith('tb1')) expect(() => validateTransfer('bitcoin', 'testnet', { asset: 'btc', to, amount: '1' }), to).not.toThrow()
      else expect(() => validateTransfer('chia', 'testnet11', { asset: 'xch', to, amount: '1' }), to).not.toThrow()
    }
  })
})

describe('documented contract', () => {
  it.each(['SKILL.md', 'README.md', 'llms-full.txt'])('%s documents exit code 5', (doc) => {
    expect(read(doc)).toMatch(/\|\s*5\s*\||exit code 5/)
  })

  it('python/README.md documents the PairingData mode and the int vs bigint value difference', () => {
    const text = read('python/README.md')
    expect(text).toMatch(/PairingData\([^)]*mode: str \| None = None[,)]/)
    expect(text).toMatch(/js sdk.*decimal string or `bigint`/i)
  })

  // the first real agent run stalled in a claude code sandbox: wss to the relay and writes to ~ were blocked
  it.each(['SKILL.md', 'README.md', 'llms-full.txt'])('%s tells sandboxed agents what the cli needs', (doc) => {
    const text = read(doc)
    expect(text).toContain('wss://relay.clanker-wallet.xyz/ws')
    // node's WebSocket ignores the sandbox's HTTPS_PROXY without it
    expect(text).toContain('NODE_USE_ENV_PROXY=1')
    // every command writes there, not only pair
    expect(text).toMatch(/writes? .*`~\/\.clanker-wallet\/`/)
    expect(text).toMatch(/allow writes/i)
    expect(text).toMatch(/"mode":\s?"managed"/)
    expect(text).toMatch(/in the background/)
  })

  it.each(['SKILL.md', 'README.md', 'llms-full.txt'])('%s documents per-family pairings and that 0.4.x pairing.json is still read', (doc) => {
    const text = read(doc)
    expect(text).toContain('~/.clanker-wallet/pairings/')
    expect(text).toContain('pairing.json')
  })

  it.each(['python/README.md', 'bin/cli.js'])('%s names the relay host to allow', (doc) => {
    expect(read(doc)).toContain('relay.clanker-wallet.xyz')
  })

  it.each(['README.md', 'llms-full.txt', 'python/README.md'])('%s states the python version next to pip install', (doc) => {
    const text = read(doc)
    expect(text).toContain('pip install clanker-wallet')
    expect(text).toMatch(/Python 3\.10\+|Python ≥ ?3\.10/)
  })
})

describe('documented mcp server', () => {
  const MCP_DOCS = ['SKILL.md', 'README.md', 'llms-full.txt']
  const SERVER_ENTRY = { command: 'npx', args: ['-y', 'clanker-wallet', 'mcp'] }

  /** every fenced json block that configures mcpServers */
  const mcpConfigs = (text: string) => [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((block) => block.includes('mcpServers'))
    .map((block) => JSON.parse(block))

  it.each(MCP_DOCS)('%s documents every mcp tool', (doc) => {
    const text = read(doc)
    expect(text).toMatch(/^##+ MCP/m)
    for (const tool of MCP_TOOLS) expect(text, tool.name).toContain(tool.name)
    expect(text).toContain(`\`wait_seconds\` (at most ${MAX_WAIT_SECONDS})`)
  })

  /** the tool's row in the doc's tools table */
  const toolRow = (text: string, name: string) => {
    const rows = text.split('\n').filter((line) => line.startsWith(`| \`${name}\` |`))
    expect(rows, `${name} row`).toHaveLength(1)
    return rows[0]
  }

  it.each(MCP_DOCS)('%s lists every argument of each tool in its row, amounts with the unit the schema states', (doc) => {
    const text = read(doc)
    for (const tool of MCP_TOOLS) {
      const row = toolRow(text, tool.name)
      for (const [key, schema] of Object.entries(tool.inputSchema.properties) as [string, { description?: string }][]) {
        expect(row, `${tool.name} ${key}`).toContain(`\`${key}\``)
        const unit = schema.description?.match(/^integer string in (\w+)/)?.[1]
        if (unit) expect(row, `${tool.name} ${key} unit`).toContain(`\`${key}\` (${unit}, integer string)`)
      }
    }
    // the units themselves, so a schema that stopped naming them can't pass vacuously
    expect(toolRow(text, 'request_evm_tx')).toContain('`value` (wei, integer string)')
    expect(toolRow(text, 'request_transfer')).toContain('`amount` (sats, integer string)')
  })

  it.each(MCP_DOCS)('%s lists exactly the statuses get_request returns', (doc) => {
    const returns = toolRow(read(doc), 'get_request').split('`status`:')[1]
    const statuses = [...returns.replace(/\(with [^)]*\)/g, '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
    expect(statuses).toEqual([...REQUEST_STATUSES])
  })

  it.each(MCP_DOCS)('%s says an expired or forgotten request may still be approved', (doc) => {
    const text = read(doc)
    expect(text).toMatch(/stops waiting and reports `expired`/)
    expect(text).toMatch(/the human may still approve the request in their wallet, so ask them before sending it again/)
    expect(text).not.toMatch(/expires after 1 h/)
  })

  it.each(MCP_DOCS)('%s names the Claude Desktop and Cursor config files', (doc) => {
    const text = read(doc)
    expect(text).toContain('Claude Desktop (`claude_desktop_config.json`)')
    expect(text).toContain('Cursor (`~/.cursor/mcp.json`)')
  })

  it.each(MCP_DOCS)('%s gives a parseable stdio config for Claude Desktop, Cursor and other hosts, and the Claude Code command', (doc) => {
    const text = read(doc)
    const configs = mcpConfigs(text)
    expect(configs.length).toBeGreaterThan(0)
    for (const config of configs) expect(config.mcpServers['clanker-wallet']).toEqual(SERVER_ENTRY)
    expect(text).toContain('claude mcp add clanker-wallet -- npx -y clanker-wallet mcp')
    expect(text).toContain('Claude Desktop')
    expect(text).toContain('Cursor')
  })
})
