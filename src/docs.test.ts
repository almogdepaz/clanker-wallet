import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateTx } from './validate.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

// documented examples run on base sepolia
const EXAMPLE_CHAIN = 84532

/** every `clanker-wallet tx --...` command in a doc (not usage lines), backslash continuations joined */
function cliTxExamples(text: string): string[] {
  const joined = text.replace(/\\\r?\n\s*/g, ' ')
  return [...joined.matchAll(/clanker-wallet tx (--.*)/g)].map((m) => m[1].split('`')[0].trim())
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
    const examples = cliTxExamples(read(doc))
    expect(examples.length).toBeGreaterThan(0)
    for (const command of examples) {
      const flags = flagsOf(command)
      expect(Number(flags.chain), command).toBe(EXAMPLE_CHAIN)
      expect(() => validateTx(Number(flags.chain), { to: flags.to, value: flags.value ?? '0', data: flags.data }), command)
        .not.toThrow()
    }
  })

  it.each(SDK_DOCS)('every sdk example in %s uses a real address and base sepolia', (doc) => {
    const text = read(doc)
    const chains = [...text.matchAll(/chain_id[:=]\s*(\d+)/g)].map((m) => Number(m[1]))
    const recipients = [...text.matchAll(/\bto[:=]\s*['"]([^'"]*)['"]/g)].map((m) => m[1])
    expect(chains.length).toBeGreaterThan(0)
    expect(recipients.length).toBeGreaterThan(0)
    for (const chain of chains) expect(chain).toBe(EXAMPLE_CHAIN)
    for (const to of recipients) expect(() => validateTx(EXAMPLE_CHAIN, { to, value: '0' }), to).not.toThrow()
  })
})

describe('documented contract', () => {
  it.each(['SKILL.md', 'README.md', 'llms-full.txt'])('%s documents exit code 5', (doc) => {
    expect(read(doc)).toMatch(/\|\s*5\s*\||exit code 5/)
  })

  it.each(['README.md', 'llms-full.txt', 'python/README.md'])('%s states the python version next to pip install', (doc) => {
    const text = read(doc)
    expect(text).toContain('pip install clanker-wallet')
    expect(text).toMatch(/Python 3\.10\+|Python ≥ ?3\.10/)
  })
})
