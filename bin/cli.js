#!/usr/bin/env node
import { ClankerWallet, InvalidTxError, validateTx } from '../dist/index.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── constants ────────────────────────────────────────────────────────
const STATE_DIR = join(homedir(), '.clanker-wallet')
const IDENTITY_FILE = join(STATE_DIR, 'identity.json')
const PAIRING_FILE = join(STATE_DIR, 'pairing.json')

const EXIT = { OK: 0, REJECTED: 1, TIMEOUT: 2, CONNECTION: 3, NOT_PAIRED: 4, BAD_ARGS: 5 }
const DEFAULT_TIMEOUT_MS = 3_600_000
/** validateTx field -> the tx flag that sets it */
const FIELD_FLAGS = { chain_id: '--chain', to: '--to', value: '--value', data: '--data' }

// ── helpers ──────────────────────────────────────────────────────────
const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
const fromHexStr = (h) => new Uint8Array(h.match(/.{2}/g).map(b => parseInt(b, 16)))
/** short id the human compares in the web app: first 16 hex (64 bits) of the x25519 pubkey, "ab12 cd34 ef56 7890" */
const fingerprint = (pubkeyHex) => pubkeyHex.slice(0, 16).toLowerCase().match(/.{1,4}/g).join(' ')

function die(msg, code) {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

// owner-only; an existing dir from an older version is tightened too
function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  else chmodSync(STATE_DIR, 0o700)
}

// identity.json holds the agent secret key: owner-only, tightened if an older version left it readable
function loadIdentity() {
  if (!existsSync(IDENTITY_FILE)) return null
  ensureDir()
  chmodSync(IDENTITY_FILE, 0o600)
  try { return JSON.parse(readFileSync(IDENTITY_FILE, 'utf8')) }
  catch { return null }
}

function saveIdentity(data) {
  ensureDir()
  writeFileSync(IDENTITY_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  chmodSync(IDENTITY_FILE, 0o600)
}

function loadPairing() {
  if (!existsSync(PAIRING_FILE)) return null
  try { return JSON.parse(readFileSync(PAIRING_FILE, 'utf8')) }
  catch { return null }
}

function savePairing(data) {
  ensureDir()
  writeFileSync(PAIRING_FILE, JSON.stringify(data, null, 2) + '\n')
}

/** restore or create a ClankerWallet with persisted identity */
function getWallet() {
  const identity = loadIdentity()
  const secretKey = identity ? fromHexStr(identity.secret_key) : undefined
  const wallet = new ClankerWallet({ secretKey })
  if (!identity) {
    saveIdentity({ secret_key: hex(wallet.secretKey), agent_id: wallet.agentId })
  }
  return wallet
}

// ── arg parsing ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2)
  const cmd = args[0]
  const positional = []
  const flags = {}

  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }

  return { cmd, positional, flags }
}

// ── commands ─────────────────────────────────────────────────────────
function cmdPair(positional) {
  const jsonStr = positional[0]
  if (!jsonStr) {
    die('usage: clanker-wallet pair \'<pairing JSON from web app>\'', EXIT.BAD_ARGS)
  }

  const wallet = getWallet()

  let pairingData
  try {
    pairingData = wallet.pair(jsonStr)
  } catch (err) {
    die(`pair failed: ${err.message}`, EXIT.BAD_ARGS)
  }

  savePairing({
    pubkey: pairingData.pubkey,
    relay: pairingData.relay,
    wallet: pairingData.wallet || null,
    mode: pairingData.mode || null,
  })

  out({
    agent_id: wallet.agentId,
    status: 'paired',
    wallet: pairingData.wallet || null,
    relay: pairingData.relay,
  })
}

async function cmdTx(flags) {
  const pairing = loadPairing()
  if (!pairing) die('not paired — run: clanker-wallet pair \'<JSON>\'', EXIT.NOT_PAIRED)

  const chain = flags.chain
  const to = flags.to
  if (!chain) die('missing --chain', EXIT.BAD_ARGS)
  if (!to) die('missing --to', EXIT.BAD_ARGS)

  if (!/^[0-9]+$/.test(chain)) die(`invalid --chain: must be a positive integer chain id, got ${JSON.stringify(chain)}`, EXIT.BAD_ARGS)
  if (flags.timeout !== undefined && !/^[1-9][0-9]*$/.test(flags.timeout)) {
    die(`invalid --timeout: must be a positive number of milliseconds, got ${JSON.stringify(flags.timeout)}`, EXIT.BAD_ARGS)
  }
  const timeout = flags.timeout ? Number(flags.timeout) : DEFAULT_TIMEOUT_MS

  // same checks requestTx runs, done here so a bad flag exits 5 instead of surfacing as a connection error
  let request
  try {
    request = validateTx(Number(chain), { to, value: flags.value ?? '0', data: flags.data ?? '0x' })
  } catch (err) {
    if (!(err instanceof InvalidTxError)) throw err
    die(`invalid ${FIELD_FLAGS[err.field]}: ${err.reason}`, EXIT.BAD_ARGS)
  }

  const context = {}
  if (flags.reason) context.reason = flags.reason
  if (flags.urgency) context.urgency = flags.urgency
  if (flags['expected-outcome']) context.expected_outcome = flags['expected-outcome']

  const wallet = getWallet()
  const pairingJson = JSON.stringify({
    version: 1,
    pubkey: pairing.pubkey,
    relay: pairing.relay,
    wallet: pairing.wallet,
    mode: pairing.mode || undefined,
  })
  wallet.pair(pairingJson)

  try {
    const txHash = await wallet.requestTx({
      chain_id: request.chain_id,
      transaction: request.transaction,
      context: Object.keys(context).length > 0 ? context : undefined,
      timeout_ms: timeout,
    })
    out({ tx_hash: txHash, status: 'approved' })
    process.exit(EXIT.OK)
  } catch (err) {
    const msg = err.message || String(err)
    if (msg.includes('rejected')) {
      out({ status: 'rejected', error: msg })
      process.exit(EXIT.REJECTED)
    } else if (msg.includes('timed out')) {
      out({ status: 'timeout', error: msg })
      process.exit(EXIT.TIMEOUT)
    } else {
      out({ status: 'error', error: msg })
      process.exit(EXIT.CONNECTION)
    }
  }
}

function cmdStatus() {
  const identity = loadIdentity()
  const pairing = loadPairing()

  out({
    agent_id: identity?.agent_id || null,
    paired: !!pairing,
    wallet: pairing?.wallet || null,
    relay: pairing?.relay || null,
  })
}

function cmdWhoami() {
  const wallet = getWallet()
  out({
    agent_id: wallet.agentId,
    public_key: hex(wallet.publicKey),
    fingerprint: fingerprint(hex(wallet.publicKey)),
  })
}

function cmdVersion() {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  process.stdout.write(version + '\n')
}

function showHelp() {
  process.stderr.write(`clanker-wallet — human-approved transactions for AI agents

commands:
  pair '<JSON>'   pair with human's web app (one-time setup)
  tx              send a transaction (blocks until approved/rejected)
  status          check pairing status
  whoami          show agent identity

tx flags:
  --chain <id>                 chain ID (required) — 1, 8453, 84532 (base sepolia), etc.
  --to <address>               recipient (required)
  --value <wei>                value in wei, not ETH (default: 0; 1 ETH = 1000000000000000000)
  --data <hex>                 calldata (default: 0x)
  --reason <text>              shown to human
  --urgency <low|medium|high>  priority hint
  --expected-outcome <text>    what will happen
  --timeout <ms>               how long tx blocks waiting for the human (default: 3600000 = 1 h)

exit codes:
  0  success
  1  rejected by human
  2  timeout
  3  connection error
  4  not paired
  5  invalid arguments

examples:
  clanker-wallet pair '{"version":1,"pubkey":"ab12...","relay":"wss://...","wallet":"0x..."}'
  clanker-wallet tx --chain 84532 --to 0x000000000000000000000000000000000000dEaD --value 1000000000000000 --reason "send 0.001 ETH on base sepolia"
  clanker-wallet status
  clanker-wallet whoami

docs: https://clanker-wallet.xyz/SKILL.md
web:  https://clanker-wallet.xyz
`)
}

// ── main ─────────────────────────────────────────────────────────────
const { cmd, positional, flags } = parseArgs(process.argv)

switch (cmd) {
  case 'pair':
    cmdPair(positional)
    break
  case 'tx':
    await cmdTx(flags)
    break
  case 'status':
    cmdStatus()
    break
  case 'whoami':
    cmdWhoami()
    break
  case '--version':
  case '-v':
    cmdVersion()
    break
  case 'help':
  case '--help':
  case '-h':
    showHelp()
    break
  default:
    showHelp()
    break
}
