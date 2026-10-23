import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTestRelay, type TestRelay } from './testRelay.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'bin', 'cli.js')

function runCli(home: string, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
}

const perms = (path: string) => statSync(path).mode & 0o777

beforeAll(() => {
  // the cli imports the built package (dist/ is gitignored); rebuild so it never runs stale code
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ROOT })
}, 60_000)

describe('cli whoami', () => {
  it('prints a 64-bit fingerprint: first 16 hex of the public key, grouped in 4s', () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const { public_key, fingerprint } = JSON.parse(runCli(home, 'whoami'))
    expect(fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/)
    expect(fingerprint.replace(/ /g, '')).toBe(public_key.slice(0, 16))
  })
})

describe('cli identity file', () => {
  it('creates the state dir and identity.json readable only by the owner', () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    runCli(home, 'whoami')
    expect(perms(join(home, '.clanker-wallet'))).toBe(0o700)
    expect(perms(join(home, '.clanker-wallet', 'identity.json'))).toBe(0o600)
  })

  it('tightens an existing identity.json on load', () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const first = runCli(home, 'whoami')
    const identity = join(home, '.clanker-wallet', 'identity.json')
    chmodSync(identity, 0o644)
    expect(runCli(home, 'whoami')).toBe(first)
    expect(perms(identity)).toBe(0o600)
  })

  it('tightens an existing state dir (N5)', () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const dir = join(home, '.clanker-wallet')
    // empty dir left by an older version
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    runCli(home, 'whoami')
    expect(perms(dir)).toBe(0o700)
    // dir with an identity already in it
    chmodSync(dir, 0o755)
    runCli(home, 'whoami')
    expect(perms(dir)).toBe(0o700)
  })
})

describe('cli tx', () => {
  const WALLET = '0x1111111111111111111111111111111111111111'
  const TO = '0x2222222222222222222222222222222222222222'
  let relay: TestRelay

  beforeAll(async () => { relay = await startTestRelay() })
  afterAll(() => relay.close())

  /** pair with the given mode, run `tx`, and return the first message it sends to the human's room */
  async function sentMessage(mode?: 'managed' | 'encrypted') {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const human = randomBytes(32).toString('hex')
    runCli(home, 'pair', JSON.stringify({ version: 1, pubkey: human, relay: relay.url, wallet: WALLET, mode }))
    const child = spawn(
      process.execPath,
      [CLI, 'tx', '--chain', '8453', '--to', TO, '--value', '5', '--data', '0xabcd', '--timeout', '10000'],
      { env: { ...process.env, HOME: home }, stdio: 'ignore' },
    )
    try {
      return await vi.waitFor(() => {
        const msg = relay.received.find((m) => m.type === 'message' && m.room === human)
        if (!msg) throw new Error('cli has not sent the request yet')
        return msg
      }, { timeout: 10_000, interval: 50 })
    } finally {
      child.kill()
    }
  }

  it('keeps a managed pairing: the relay gets the simulate fields (S4)', async () => {
    const msg = await sentMessage('managed')
    expect(msg.simulate).toEqual({ from: WALLET, to: TO, value: '5', data: '0xabcd', chainId: 8453 })
  })

  it('sends no simulate fields for an encrypted pairing', async () => {
    const msg = await sentMessage('encrypted')
    expect(msg.simulate).toBeUndefined()
  })

  // the two literal requests from the prod e2e report, plus the other per-flag rules
  it.each([
    ['--to', ['--chain', '1', '--to', '0x...', '--value', '0']],
    ['--data', ['--chain', '1', '--to', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '--data',
      '0xa9059cbb000000000000000000000000RecipientAddr00000000000000000000000000000000000000000000000000000000000f4240']],
    ['--to', ['--chain', '1', '--to', '--value', '0']],
    ['--to', ['--chain', '1', '--to', '0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48']],
    ['--value', ['--chain', '1', '--to', TO, '--value', '0.5']],
    ['--value', ['--chain', '1', '--to', TO, '--value', '1e18']],
    ['--chain', ['--chain', '8453abc', '--to', TO]],
    ['--chain', ['--chain', '0', '--to', TO]],
    ['--timeout', ['--chain', '1', '--to', TO, '--timeout', 'soon']],
  ])('rejects a bad %s with exit 5 before contacting the relay', (flag, args) => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const human = randomBytes(32).toString('hex')
    runCli(home, 'pair', JSON.stringify({ version: 1, pubkey: human, relay: relay.url, wallet: WALLET, mode: 'managed' }))
    // short timeout so an accepted request fails fast instead of waiting for a human
    const timeout = args.includes('--timeout') ? [] : ['--timeout', '3000']
    const res = spawnSync(process.execPath, [CLI, 'tx', ...args, ...timeout], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    })
    expect(res.status).toBe(5)
    expect(res.stderr.trim().split('\n')).toHaveLength(1)
    expect(res.stderr).toContain(flag)
    expect(relay.received.filter((m) => m.room === human)).toEqual([])
  })
})

describe('cli --help', () => {
  it('points at the agent skill and states the tx timeout', () => {
    const res = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    // help goes to stderr; stdout stays for json results
    expect(res.stderr).toContain('docs: https://clanker-wallet.xyz/SKILL.md')
    expect(res.stderr).toMatch(/--timeout <ms>.*1 h/)
    // same urgency names as the docs
    expect(res.stderr).toContain('--urgency <low|medium|high>')
  })
})

describe('cli --version', () => {
  it.each(['--version', '-v'])('%s prints the package version', (flag) => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const res = spawnSync(process.execPath, [CLI, flag], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe(version)
  })
})
