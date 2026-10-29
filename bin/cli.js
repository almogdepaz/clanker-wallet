#!/usr/bin/env node
import { ClankerWallet, InvalidTxError, validateTransfer, validateTx } from '../dist/index.js'
import { createMcpServer, MAX_WAIT_SECONDS, REQUEST_STATUSES } from '../dist/mcp.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'

// ── constants ────────────────────────────────────────────────────────
const STATE_DIR = join(homedir(), '.clanker-wallet')
const IDENTITY_FILE = join(STATE_DIR, 'identity.json')
// one pairing per chain family: pairings/<family>.json. 0.4.x wrote pairing.json (evm only); it is still read as the
// evm pairing and never moved, rewritten or deleted
const PAIRINGS_DIR = join(STATE_DIR, 'pairings')
const LEGACY_PAIRING_FILE = join(STATE_DIR, 'pairing.json')
const FAMILIES = ['evm', 'bitcoin', 'chia']

const EXIT = { OK: 0, REJECTED: 1, TIMEOUT: 2, CONNECTION: 3, NOT_PAIRED: 4, BAD_ARGS: 5 }
const DEFAULT_TIMEOUT_MS = 3_600_000
/** validateTx field -> the tx flag that sets it */
const FIELD_FLAGS = { chain_id: '--chain', to: '--to', value: '--value', data: '--data' }
/** per send network flag (named after the asset it sends): the pairing family it uses and its amount/fee flags */
const SEND_FAMILIES = {
  btc: { family: 'bitcoin', amountFlag: 'sats', networks: 'mainnet, testnet or signet' },
  xch: { family: 'chia', amountFlag: 'mojos', feeFlag: 'fee-mojos', networks: 'mainnet or testnet11' },
}

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

function readJson(path) {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return null }
}

function loadPairing(family) {
  return readJson(join(PAIRINGS_DIR, `${family}.json`)) ?? (family === 'evm' ? readJson(LEGACY_PAIRING_FILE) : null)
}

function savePairing(family, data) {
  ensureDir()
  if (!existsSync(PAIRINGS_DIR)) mkdirSync(PAIRINGS_DIR, { mode: 0o700 })
  writeFileSync(join(PAIRINGS_DIR, `${family}.json`), JSON.stringify(data, null, 2) + '\n')
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

  // the family names the pairing file, so only the known ones are accepted
  const family = pairingData.chain_family || 'evm'
  if (!FAMILIES.includes(family)) {
    die(`pair failed: unsupported chain_family ${JSON.stringify(family)} (expected ${FAMILIES.join(', ')})`, EXIT.BAD_ARGS)
  }

  savePairing(family, {
    pubkey: pairingData.pubkey,
    relay: pairingData.relay,
    wallet: pairingData.wallet || null,
    mode: pairingData.mode || null,
    chain_family: pairingData.chain_family,
    chain_network: pairingData.chain_network,
  })

  out({
    agent_id: wallet.agentId,
    status: 'paired',
    wallet: pairingData.wallet || null,
    relay: pairingData.relay,
    ...(family !== 'evm' && { chain_family: family }),
  })
}

function parseTimeout(flags) {
  if (flags.timeout !== undefined && !/^[1-9][0-9]*$/.test(flags.timeout)) {
    die(`invalid --timeout: must be a positive number of milliseconds, got ${JSON.stringify(flags.timeout)}`, EXIT.BAD_ARGS)
  }
  return flags.timeout ? Number(flags.timeout) : DEFAULT_TIMEOUT_MS
}

function contextFrom(flags) {
  const context = {}
  if (flags.reason) context.reason = flags.reason
  if (flags.urgency) context.urgency = flags.urgency
  if (flags['expected-outcome']) context.expected_outcome = flags['expected-outcome']
  return Object.keys(context).length > 0 ? context : undefined
}

/** a ClankerWallet paired from a saved pairing */
function pairedWallet(pairing) {
  const wallet = getWallet()
  wallet.pair(JSON.stringify({
    version: 1,
    pubkey: pairing.pubkey,
    relay: pairing.relay,
    wallet: pairing.wallet,
    mode: pairing.mode || undefined,
    chain_family: pairing.chain_family,
    chain_network: pairing.chain_network,
  }))
  return wallet
}

/** wait for the human's answer and exit with its code */
async function exitWithResult(request) {
  try {
    const txHash = await request
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

async function cmdTx(flags) {
  const pairing = loadPairing('evm')
  if (!pairing) die('not paired — run: clanker-wallet pair \'<JSON>\'', EXIT.NOT_PAIRED)

  const chain = flags.chain
  const to = flags.to
  if (!chain) die('missing --chain', EXIT.BAD_ARGS)
  if (!to) die('missing --to', EXIT.BAD_ARGS)

  if (!/^[0-9]+$/.test(chain)) die(`invalid --chain: must be a positive integer chain id, got ${JSON.stringify(chain)}`, EXIT.BAD_ARGS)
  const timeout = parseTimeout(flags)

  // same checks requestTx runs, done here so a bad flag exits 5 instead of surfacing as a connection error
  let request
  try {
    request = validateTx(Number(chain), { to, value: flags.value ?? '0', data: flags.data ?? '0x' })
  } catch (err) {
    if (!(err instanceof InvalidTxError)) throw err
    die(`invalid ${FIELD_FLAGS[err.field]}: ${err.reason}`, EXIT.BAD_ARGS)
  }

  const wallet = pairedWallet(pairing)
  await exitWithResult(wallet.requestTx({
    chain_id: request.chain_id,
    transaction: request.transaction,
    context: contextFrom(flags),
    timeout_ms: timeout,
  }))
}

async function cmdSend(flags) {
  const picked = Object.keys(SEND_FAMILIES).filter((flag) => flags[flag] !== undefined)
  if (picked.length !== 1) die('invalid --btc/--xch: give exactly one of --btc <network> or --xch <network>', EXIT.BAD_ARGS)
  const networkFlag = picked[0]
  const { family, amountFlag, feeFlag, networks } = SEND_FAMILIES[networkFlag]
  const network = flags[networkFlag]
  if (network === true) die(`invalid --${networkFlag}: give the network, ${networks}`, EXIT.BAD_ARGS)

  // another family's amount/fee flag is a mistake, not something to ignore
  for (const flag of ['sats', 'mojos', 'fee-mojos']) {
    if (flag !== amountFlag && flag !== feeFlag && flags[flag] !== undefined) {
      die(`invalid --${flag}: not a --${networkFlag} flag (${family} amounts are --${amountFlag}${feeFlag ? `, fee --${feeFlag}` : ', and the wallet sets the fee'})`, EXIT.BAD_ARGS)
    }
  }
  for (const flag of ['to', amountFlag, feeFlag]) {
    if (flag && flags[flag] === true) die(`invalid --${flag}: missing value`, EXIT.BAD_ARGS)
  }

  const pairing = loadPairing(family)
  if (!pairing) die(`not paired with a ${family} wallet — open the web app's ${family} tab and run: clanker-wallet pair '<JSON>'`, EXIT.NOT_PAIRED)

  if (!flags.to) die('missing --to', EXIT.BAD_ARGS)
  if (flags[amountFlag] === undefined) die(`missing --${amountFlag}`, EXIT.BAD_ARGS)
  const timeout = parseTimeout(flags)

  const transfer = { asset: networkFlag, to: flags.to, amount: flags[amountFlag] }
  if (feeFlag && flags[feeFlag] !== undefined) transfer.fee = flags[feeFlag]
  const flagFor = { chain_family: networkFlag, chain_network: networkFlag, asset: networkFlag, to: 'to', amount: amountFlag, fee: feeFlag }
  const badArg = (err) => die(`invalid --${flagFor[err.field]}: ${err.reason}`, EXIT.BAD_ARGS)

  // same checks requestTransfer runs, done here so a bad flag exits 5 instead of surfacing as a connection error
  try {
    validateTransfer(family, network, transfer)
  } catch (err) {
    if (!(err instanceof InvalidTxError)) throw err
    badArg(err)
  }

  const wallet = pairedWallet(pairing)
  // requestTransfer also refuses a network the pairing isn't for; that is a bad flag too
  const request = wallet.requestTransfer({ chain_network: network, transfer, context: contextFrom(flags), timeout_ms: timeout })
  await request.catch((err) => { if (err instanceof InvalidTxError) badArg(err) })
  await exitWithResult(request)
}

function cmdStatus() {
  const identity = loadIdentity()
  const pairings = {}
  for (const family of FAMILIES) {
    const pairing = loadPairing(family)
    if (pairing) {
      pairings[family] = { wallet: pairing.wallet || null, relay: pairing.relay || null, mode: pairing.mode || null, chain_network: pairing.chain_network || null }
    }
  }
  const evm = pairings.evm

  // wallet/relay stay the evm pairing's, as in 0.4.x
  out({
    agent_id: identity?.agent_id || null,
    paired: Object.keys(pairings).length > 0,
    wallet: evm?.wallet || null,
    relay: evm?.relay || null,
    pairings,
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

function packageVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

function cmdVersion() {
  process.stdout.write(packageVersion() + '\n')
}

function showMcpHelp() {
  process.stderr.write(`clanker-wallet mcp — MCP server over stdio for assistants (Claude Desktop, Claude Code, Cursor, ...)

uses this agent's identity and pairings (~/.clanker-wallet/); pair first with: clanker-wallet pair '<JSON>'
every request waits for the human to approve it on their own device.

tools:
  request_evm_tx    ask for an evm transaction (value in wei, integer string) -> { request_id }
  request_transfer  ask for a bitcoin send (amount in sats, integer string) -> { request_id }
  get_request       ${REQUEST_STATUSES.join(' | ')}; wait_seconds up to ${MAX_WAIT_SECONDS}
  list_pairings     paired chain families, networks, wallets, and the agent fingerprint

claude code:     claude mcp add clanker-wallet -- npx -y clanker-wallet mcp
other hosts:     {"mcpServers":{"clanker-wallet":{"command":"npx","args":["-y","clanker-wallet","mcp"]}}}

requests are kept in memory: after 1 h the server stops waiting (expired), and a restart forgets pending ones.
expired, unknown (relay lost after delivery) or forgotten: the human may still approve it, so ask before sending it again.
docs: https://clanker-wallet.xyz/SKILL.md
`)
}

/** serve MCP on stdin/stdout until stdin ends; stdout carries only protocol messages */
async function cmdMcp(flags) {
  if (flags.help) return showMcpHelp()

  const identity = getWallet()
  const server = createMcpServer({
    version: packageVersion(),
    identity: { agent_id: identity.agentId, fingerprint: fingerprint(hex(identity.publicKey)) },
    loadPairing,
    wallet: pairedWallet,
  })
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  // each line is answered when it settles, so a get_request that waits never holds up the others
  lines.on('line', (line) => {
    server.handleLine(line).then((reply) => { if (reply) process.stdout.write(reply + '\n') })
  })
  await new Promise((resolve) => lines.on('close', resolve))
  // the host is gone: drop pending requests (their relay sockets would keep the process alive)
  process.exit(EXIT.OK)
}

function showHelp() {
  process.stderr.write(`clanker-wallet — human-approved transactions for AI agents

commands:
  pair '<JSON>'   pair with human's web app (one-time setup)
  tx              send an evm transaction (blocks until approved/rejected)
  send            send btc or xch; the human's wallet builds it (blocks until approved/rejected)
  status          check pairing status (one pairing per chain family: evm, bitcoin, chia)
  whoami          show agent identity
  mcp             run an MCP server over stdio for assistants (Claude Desktop/Code, Cursor, ...); mcp --help

tx flags:
  --chain <id>                 chain ID (required) — 1, 8453, 84532 (base sepolia), etc.
  --to <address>               recipient (required)
  --value <wei>                value in wei, not ETH (default: 0; 1 ETH = 1000000000000000000)
  --data <hex>                 calldata (default: 0x)
  --reason <text>              shown to human
  --urgency <low|medium|high>  priority hint
  --expected-outcome <text>    what will happen
  --timeout <ms>               how long tx blocks waiting for the human (default: 3600000 = 1 h)

send flags (pair the web app's bitcoin or chia tab first):
  send --btc <mainnet|testnet|signet> --to <address> --sats <n>
  send --xch <mainnet|testnet11> --to <address> --mojos <n> [--fee-mojos <n>]
  --to <address>               recipient: segwit bc1/tb1 for bitcoin, xch1/txch1 for chia (required)
  --sats <n>                   bitcoin amount in sats (1 BTC = 100000000); the wallet sets the fee
  --mojos <n>                  chia amount in mojos (1 XCH = 1000000000000)
  --fee-mojos <n>              chia fee in mojos (default: 0), shown to the human
  --reason, --urgency, --expected-outcome, --timeout   as for tx

exit codes:
  0  success
  1  rejected by human
  2  timeout
  3  connection error (in a sandbox or behind a firewall, allow the relay host, wss://relay.clanker-wallet.xyz/ws by default;
     behind HTTPS_PROXY run with NODE_USE_ENV_PROXY=1)
  4  not paired (send: not paired for that chain family)
  5  invalid arguments

examples:
  clanker-wallet pair '{"version":1,"pubkey":"ab12...","relay":"wss://...","wallet":"0x..."}'
  clanker-wallet tx --chain 84532 --to 0x000000000000000000000000000000000000dEaD --value 1000000000000000 --reason "send 0.001 ETH on base sepolia"
  clanker-wallet send --btc testnet --to tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx --sats 1000 --reason "test payment"
  clanker-wallet send --xch testnet11 --to txch1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sw0amhg --mojos 1000 --fee-mojos 0
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
  case 'send':
    await cmdSend(flags)
    break
  case 'status':
    cmdStatus()
    break
  case 'whoami':
    cmdWhoami()
    break
  case 'mcp':
    await cmdMcp(flags)
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
