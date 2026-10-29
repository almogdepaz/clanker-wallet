import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, chmodSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import nacl from 'tweetnacl'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { decryptMessage, encryptMessage, fromHex, toHex } from './crypto.js'
import { REQUEST_STATUSES } from './mcp.js'
import { joinAsHuman, startTestRelay, type TestRelay } from './testRelay.js'

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

  it('names the relay url when it cannot be reached (exit 3)', () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    // nothing listens on port 1
    const deadRelay = 'ws://127.0.0.1:1'
    runCli(home, 'pair', JSON.stringify({ version: 1, pubkey: randomBytes(32).toString('hex'), relay: deadRelay, wallet: WALLET }))
    const res = spawnSync(process.execPath, [CLI, 'tx', '--chain', '84532', '--to', TO, '--value', '1', '--timeout', '5000'], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    })
    expect(res.status).toBe(3)
    const { status, error } = JSON.parse(res.stdout)
    expect(status).toBe('error')
    expect(error).toContain(deadRelay)
  })

  // claude code's sandbox only lets traffic out through HTTPS_PROXY, which node's WebSocket ignores without NODE_USE_ENV_PROXY
  it.each([
    ['proxy set, node not told to use it', { HTTPS_PROXY: 'http://127.0.0.1:1' }, true],
    ['no proxy', {}, false],
  ])('relay error names NODE_USE_ENV_PROXY only when it would help: %s', (_name, proxyEnv, hinted) => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const deadRelay = 'ws://127.0.0.1:1'
    runCli(home, 'pair', JSON.stringify({ version: 1, pubkey: randomBytes(32).toString('hex'), relay: deadRelay, wallet: WALLET }))
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, ...proxyEnv }
    for (const key of ['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'http_proxy', 'https_proxy', ...(hinted ? [] : ['HTTPS_PROXY'])]) delete env[key]
    const res = spawnSync(process.execPath, [CLI, 'tx', '--chain', '84532', '--to', TO, '--value', '1', '--timeout', '5000'], { env, encoding: 'utf8' })
    expect(res.status).toBe(3)
    const { error } = JSON.parse(res.stdout)
    expect(error.includes('NODE_USE_ENV_PROXY=1')).toBe(hinted)
  })
})

describe('cli pairings per family', () => {
  const WALLET = '0x1111111111111111111111111111111111111111'
  const TO = '0x2222222222222222222222222222222222222222'
  const TXCH = 'txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg'
  const BTC_TEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
  let relay: TestRelay

  beforeAll(async () => { relay = await startTestRelay() })
  afterAll(() => relay.close())

  const pairingJson = (pubkey: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: 1, pubkey, relay: relay.url, wallet: WALLET, ...extra })

  /** run the cli and return the first message it sends to `room` */
  async function firstMessage(home: string, room: string, args: string[]) {
    const child = spawn(process.execPath, [CLI, ...args, '--timeout', '10000'], { env: { ...process.env, HOME: home }, stdio: 'ignore' })
    try {
      return await vi.waitFor(() => {
        const msg = relay.received.find((m) => m.type === 'message' && m.room === room)
        if (!msg) throw new Error('cli has not sent the request yet')
        return msg
      }, { timeout: 10_000, interval: 50 })
    } finally {
      child.kill()
    }
  }

  function send(home: string, ...args: string[]) {
    return spawnSync(process.execPath, [CLI, 'send', ...args, '--timeout', '3000'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  }

  it('stores each family in pairings/<family>.json and lists them all in status', () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const evm = randomBytes(32).toString('hex')
    const chia = randomBytes(32).toString('hex')
    runCli(home, 'pair', pairingJson(evm))
    expect(JSON.parse(runCli(home, 'pair', pairingJson(chia, { wallet: 'xch1me', chain_family: 'chia' }))))
      .toMatchObject({ status: 'paired', chain_family: 'chia', wallet: 'xch1me' })

    const dir = join(home, '.clanker-wallet')
    expect(JSON.parse(readFileSync(join(dir, 'pairings', 'evm.json'), 'utf8'))).toEqual({ pubkey: evm, relay: relay.url, wallet: WALLET, mode: null })
    expect(JSON.parse(readFileSync(join(dir, 'pairings', 'chia.json'), 'utf8')))
      .toEqual({ pubkey: chia, relay: relay.url, wallet: 'xch1me', mode: null, chain_family: 'chia' })
    expect(existsSync(join(dir, 'pairing.json'))).toBe(false)

    expect(JSON.parse(runCli(home, 'status'))).toMatchObject({
      paired: true,
      wallet: WALLET,
      relay: relay.url,
      pairings: {
        evm: { wallet: WALLET, relay: relay.url, chain_network: null },
        chia: { wallet: 'xch1me', relay: relay.url, chain_network: null },
      },
    })
  })

  it('reads a 0.4.x pairing.json as the evm pairing and never touches it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const legacyRoom = randomBytes(32).toString('hex')
    const dir = join(home, '.clanker-wallet')
    mkdirSync(dir, { mode: 0o700 })
    const legacy = join(dir, 'pairing.json')
    const legacyText = JSON.stringify({ pubkey: legacyRoom, relay: relay.url, wallet: WALLET, mode: null }, null, 2) + '\n'
    writeFileSync(legacy, legacyText)

    expect(JSON.parse(runCli(home, 'status'))).toMatchObject({ paired: true, wallet: WALLET, pairings: { evm: { wallet: WALLET } } })
    runCli(home, 'pair', pairingJson(randomBytes(32).toString('hex'), { chain_family: 'bitcoin' }))
    const msg = await firstMessage(home, legacyRoom, ['tx', '--chain', '84532', '--to', TO, '--value', '1'])
    expect(msg.room).toBe(legacyRoom)
    expect(readFileSync(legacy, 'utf8')).toBe(legacyText)
  })

  it('send --xch reaches the chia pairing with the transfer and no simulate object', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const human = nacl.box.keyPair()
    const room = toHex(human.publicKey)
    runCli(home, 'pair', pairingJson(randomBytes(32).toString('hex'), { mode: 'managed' }))
    runCli(home, 'pair', pairingJson(room, { wallet: 'xch1me', chain_family: 'chia', mode: 'managed' }))

    const msg = await firstMessage(home, room, ['send', '--xch', 'testnet11', '--to', TXCH, '--mojos', '5', '--fee-mojos', '1', '--reason', 'pay', '--urgency', 'low'])
    expect(msg.simulate).toBeUndefined()
    const envelope = JSON.parse(msg.payload)
    const req = JSON.parse(decryptMessage(envelope.ciphertext, fromHex(envelope.sender_pubkey), human.secretKey)!)
    expect(req).toMatchObject({
      chain_family: 'chia',
      chain_network: 'testnet11',
      transfer: { asset: 'xch', to: TXCH, amount: '5', fee: '1' },
      context: { reason: 'pay', urgency: 'low' },
    })
    expect(req.chain_id).toBeUndefined()
    expect(req.transaction).toBeUndefined()
  })

  it('send --btc prints the txid on approval (exit 0)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const human = nacl.box.keyPair()
    const room = toHex(human.publicKey)
    runCli(home, 'pair', pairingJson(room, { wallet: 'tb1me', chain_family: 'bitcoin' }))

    const ws = new WebSocket(relay.url)
    await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
    ws.send(JSON.stringify({ type: 'join', room }))
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data as string)
      if (frame.type !== 'message') return
      const envelope = JSON.parse(frame.payload)
      if (envelope.sender_pubkey === room) return
      const req = JSON.parse(decryptMessage(envelope.ciphertext, fromHex(envelope.sender_pubkey), human.secretKey)!)
      const reply = { request_id: req.request_id, status: 'approved', tx_hash: 'ab'.repeat(32) }
      ws.send(JSON.stringify({
        type: 'message',
        room,
        payload: JSON.stringify({ sender_pubkey: room, ciphertext: encryptMessage(JSON.stringify(reply), fromHex(envelope.sender_pubkey), human.secretKey) }),
      }))
    })

    try {
      const child = spawn(process.execPath, [CLI, 'send', '--btc', 'testnet', '--to', BTC_TEST, '--sats', '1000', '--timeout', '10000'],
        { env: { ...process.env, HOME: home } })
      let stdout = ''
      child.stdout.on('data', (d) => { stdout += d })
      const code = await new Promise((resolve) => child.on('exit', resolve))
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ tx_hash: 'ab'.repeat(32), status: 'approved' })
    } finally {
      ws.close()
    }
  })

  it('send exits 4 when that family is not paired', () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    runCli(home, 'pair', pairingJson(randomBytes(32).toString('hex')))
    const res = send(home, '--xch', 'testnet11', '--to', TXCH, '--mojos', '5')
    expect(res.status).toBe(4)
    expect(res.stderr).toContain('chia')
  })

  it.each([
    ['--btc', ['--btc', '--to', BTC_TEST, '--sats', '1']],
    ['--btc', ['--btc', 'regtest', '--to', BTC_TEST, '--sats', '1']],
    ['--xch', ['--btc', 'testnet', '--xch', 'testnet11', '--to', BTC_TEST, '--sats', '1']],
    ['--to', ['--btc', 'mainnet', '--to', BTC_TEST, '--sats', '1']],
    ['--to', ['--btc', 'testnet', '--to', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', '--sats', '1']],
    ['--sats', ['--btc', 'testnet', '--to', BTC_TEST, '--sats', '0.5']],
    ['--sats', ['--btc', 'testnet', '--to', BTC_TEST]],
    ['--mojos', ['--btc', 'testnet', '--to', BTC_TEST, '--sats', '1', '--mojos', '1']],
    ['--fee-mojos', ['--btc', 'testnet', '--to', BTC_TEST, '--sats', '1', '--fee-mojos', '1']],
    ['--sats', ['--xch', 'testnet11', '--to', TXCH, '--sats', '1']],
    ['--to', ['--xch', 'mainnet', '--to', TXCH, '--mojos', '1']],
    ['--fee-mojos', ['--xch', 'testnet11', '--to', TXCH, '--mojos', '1', '--fee-mojos', '-1']],
    ['--xch', ['--xch', 'mainnet', '--to', 'xch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0srg6dkm', '--mojos', '1'], 'testnet11'],
    ['--timeout', ['--xch', 'testnet11', '--to', TXCH, '--mojos', '1', '--timeout', 'soon']],
  ])('send rejects a bad %s with exit 5 before contacting the relay', (flag, args, pairedNetwork?: string) => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const btcRoom = randomBytes(32).toString('hex')
    const chiaRoom = randomBytes(32).toString('hex')
    runCli(home, 'pair', pairingJson(btcRoom, { chain_family: 'bitcoin' }))
    runCli(home, 'pair', pairingJson(chiaRoom, { chain_family: 'chia', ...(pairedNetwork && { chain_network: pairedNetwork }) }))
    const res = spawnSync(process.execPath, [CLI, 'send', ...args, ...(args.includes('--timeout') ? [] : ['--timeout', '3000'])], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    })
    expect(res.status).toBe(5)
    expect(res.stderr.trim().split('\n')).toHaveLength(1)
    expect(res.stderr).toContain(flag)
    expect(relay.received.filter((m) => m.room === btcRoom || m.room === chiaRoom)).toEqual([])
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
    expect(res.stderr).toContain('send --btc <mainnet|testnet|signet>')
    expect(res.stderr).toContain('send --xch <mainnet|testnet11>')
    expect(res.stderr).toMatch(/^  mcp +.*MCP server/m)
  })
})

describe('cli mcp', () => {
  const WALLET = '0x1111111111111111111111111111111111111111'
  const TO = '0x2222222222222222222222222222222222222222'
  let relay: TestRelay

  beforeAll(async () => { relay = await startTestRelay() })
  afterAll(() => relay.close())

  it('mcp --help prints usage on stderr, keeps stdout empty, and creates no identity', () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const res = spawnSync(process.execPath, [CLI, 'mcp', '--help'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).toContain('clanker-wallet mcp')
    expect(res.stderr).toContain('request_evm_tx')
    expect(res.stderr).toContain(`get_request       ${REQUEST_STATUSES.join(' | ')};`)
    expect(res.stderr).toMatch(/the human may still approve/)
    expect(existsSync(join(home, '.clanker-wallet'))).toBe(false)
  })

  it('answers a malformed line with a parse error, keeps serving, and exits 0 when stdin ends', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, HOME: home } })
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stdin.write('this is not json\n')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n')
    await vi.waitFor(() => { if (stdout.split('\n').filter(Boolean).length < 2) throw new Error('waiting for replies') }, { timeout: 10_000, interval: 50 })
    child.stdin.end()
    const code = await new Promise((resolve) => child.on('exit', resolve))
    expect(code).toBe(0)
    // stdout carries only protocol messages
    const replies = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: expect.any(String) } },
      { jsonrpc: '2.0', id: 7, result: {} },
    ])
  }, 20_000)

  it('conforms to the MCP SDK stdio client: initialize, tools/list, and a request approved through the relay', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const human = await joinAsHuman(relay.url, (req) => ({ request_id: req.request_id, status: 'approved', tx_hash: '0x' + 'cd'.repeat(32) }))
    runCli(home, 'pair', JSON.stringify({ version: 1, pubkey: human.room, relay: relay.url, wallet: WALLET }))

    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, HOME: home } as Record<string, string>, stderr: 'pipe' })
    const client = new Client({ name: 'conformance', version: '1.0.0' })
    try {
      await client.connect(transport)
      const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
      expect(client.getServerVersion()).toEqual({ name: 'clanker-wallet', version })

      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['request_evm_tx', 'request_transfer', 'get_request', 'list_pairings'])

      const sent = await client.callTool({ name: 'request_evm_tx', arguments: { chain_id: 84532, to: TO, value: '1', reason: 'conformance' } })
      expect(sent.isError).toBeFalsy()
      const { request_id } = JSON.parse((sent.content as any)[0].text)

      const got = await client.callTool({ name: 'get_request', arguments: { request_id, wait_seconds: 5 } })
      expect(JSON.parse((got.content as any)[0].text)).toEqual({ request_id, status: 'approved', tx_hash: '0x' + 'cd'.repeat(32) })
      // the agent identity is the cli's: the same one `whoami` shows
      const { agent_id } = JSON.parse(runCli(home, 'whoami'))
      expect(human.requests[0].agent_id).toBe(agent_id)

      // context keys go out in the cli's order, whatever order the assistant passes them in
      await client.callTool({ name: 'request_evm_tx', arguments: { expected_outcome: 'paid', urgency: 'low', reason: 'via mcp', chain_id: 84532, to: TO, value: '1' } })
      const tx = spawn(process.execPath, [CLI, 'tx', '--chain', '84532', '--to', TO, '--value', '1', '--expected-outcome', 'paid', '--urgency', 'low', '--reason', 'via cli', '--timeout', '10000'],
        { env: { ...process.env, HOME: home }, stdio: 'ignore' })
      expect(await new Promise((resolve) => tx.on('exit', resolve))).toBe(0)
      const contextKeys = (reason: string) => Object.keys(human.requests.find((r) => r.context?.reason === reason).context)
      expect(contextKeys('via mcp')).toEqual(contextKeys('via cli'))
      expect(contextKeys('via cli')).toEqual(['reason', 'urgency', 'expected_outcome'])
    } finally {
      await client.close()
      human.close()
    }
  }, 20_000)
})

describe('cli mcp identity', () => {
  const WALLET = '0x1111111111111111111111111111111111111111'
  const TO = '0x2222222222222222222222222222222222222222'
  let relay: TestRelay
  beforeAll(async () => { relay = await startTestRelay() })
  afterAll(() => relay.close())

  it('keeps the startup identity for every request, even when identity.json disappears mid-run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'clanker-cli-'))
    const human = await joinAsHuman(relay.url, (req) => ({ request_id: req.request_id, status: 'approved', tx_hash: '0x' + 'ef'.repeat(32) }))
    runCli(home, 'pair', JSON.stringify({ version: 1, pubkey: human.room, relay: relay.url, wallet: WALLET }))
    const identityFile = join(home, '.clanker-wallet', 'identity.json')

    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, HOME: home } as Record<string, string>, stderr: 'pipe' })
    const client = new Client({ name: 'identity', version: '1.0.0' })
    const request = async () => {
      const sent = await client.callTool({ name: 'request_evm_tx', arguments: { chain_id: 84532, to: TO, value: '1', reason: 'identity' } })
      expect(sent.isError).toBeFalsy()
      const { request_id } = JSON.parse((sent.content as any)[0].text)
      await client.callTool({ name: 'get_request', arguments: { request_id, wait_seconds: 5 } })
    }
    try {
      await client.connect(transport)
      await request()
      rmSync(identityFile)
      await request()
      expect(human.requests).toHaveLength(2)
      expect(human.requests[1].agent_id).toBe(human.requests[0].agent_id)
      // nothing regenerated a key behind the human's back
      expect(existsSync(identityFile)).toBe(false)
    } finally {
      await client.close()
      human.close()
    }
  }, 20_000)
})

describe('cli --version', () => {
  it.each(['--version', '-v'])('%s prints the package version', (flag) => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const res = spawnSync(process.execPath, [CLI, flag], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe(version)
  })
})
