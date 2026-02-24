#!/usr/bin/env node
import { ClankerWallet } from '../dist/index.js'

const cmd = process.argv[2]

if (cmd === 'keygen') {
  const wallet = new ClankerWallet()
  const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  console.log(`agent_id:    ${wallet.agentId}`)
  console.log(`public_key:  ${hex(wallet.publicKey)}`)
  console.log(`secret_key:  ${hex(wallet.secretKey)}`)
  console.log(`\nsave the secret_key to restore this identity later:`)
  console.log(`  new ClankerWallet({ secretKey: fromHex('${hex(wallet.secretKey)}') })`)
} else {
  console.log(`clanker-wallet — AI agent wallet SDK

usage:
  npx clanker-wallet keygen    generate a new agent keypair
  bunx clanker-wallet keygen   (same, via bun)

install:
  npm install clanker-wallet
  bun add clanker-wallet
  pip install clanker-wallet   (python SDK in python/)

docs: https://github.com/almogdepaz/clanker-wallet
web:  https://clanker-wallet.xyz`)
}
