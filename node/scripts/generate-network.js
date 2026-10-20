#!/usr/bin/env node
// node/scripts/generate-network.js
//
// Creates the permissioned network definition:
//   <out>/genesis.json          authority set and public keys (shareable)
//   <out>/keys/<nodeId>.json    private key per node (keep secret, one per server)
//   <out>/keys/data.key         shared key that wraps per-document encryption keys
// and, with --env, a .env file containing a random JWT_SECRET.
//
// Usage:
//   node scripts/generate-network.js --authorities node-1,node-2,node-3,node-4 \
//        [--observers observer-1] [--chain-id ctu-dms] [--out ../network] [--env ../.env] [--force]
//
// Without --force the script does nothing if genesis.json already exists, so it is
// safe to run on every startup (the Docker init service does this).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateKeyPair } = require('../crypto/util');
const { DEFAULT_NETWORK_DIR } = require('../network/config');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out || DEFAULT_NETWORK_DIR);
  const authorities = String(args.authorities || 'node-1,node-2,node-3,node-4').split(',').map(s => s.trim()).filter(Boolean);
  const observers = args.observers ? String(args.observers).split(',').map(s => s.trim()).filter(Boolean) : [];
  const chainId = args['chain-id'] || 'ctu-document-ledger';
  const genesisPath = path.join(out, 'genesis.json');

  if (fs.existsSync(genesisPath) && !args.force) {
    console.log(`Network already defined at ${genesisPath} (use --force to regenerate). Nothing to do.`);
    writeEnv(args.env);
    return;
  }

  const ids = [...authorities, ...observers];
  if (new Set(ids).size !== ids.length) throw new Error('Node ids must be unique');

  fs.mkdirSync(path.join(out, 'keys'), { recursive: true, mode: 0o700 });

  const members = [];
  for (const nodeId of ids) {
    const { publicKey, privateKey } = generateKeyPair();
    fs.writeFileSync(path.join(out, 'keys', `${nodeId}.json`), JSON.stringify({ nodeId, privateKey }, null, 2), { mode: 0o600 });
    members.push({ nodeId, role: authorities.includes(nodeId) ? 'authority' : 'observer', publicKey });
  }

  fs.writeFileSync(path.join(out, 'keys', 'data.key'), crypto.randomBytes(32).toString('base64'), { mode: 0o600 });

  const genesis = {
    chainId,
    createdAt: Date.now(),
    members,
    consensus: {
      roundTimeoutMs: Number(args['round-timeout'] || 4000),
      maxTransactionsPerBlock: 200
    }
  };
  fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2));

  const n = authorities.length;
  const f = Math.floor((n - 1) / 3);
  console.log(`Created network "${chainId}" in ${out}`);
  console.log(`  Authorities: ${authorities.join(', ')} (n=${n}, tolerates f=${f} faulty, quorum=${n - f})`);
  if (observers.length) console.log(`  Observers:   ${observers.join(', ')}`);
  if (f === 0) console.log('  Note: with fewer than 4 authorities the network cannot tolerate any faulty or offline authority.');
  writeEnv(args.env);
}

function writeEnv(envPath) {
  if (!envPath || envPath === true) return;
  const p = path.resolve(envPath);
  if (fs.existsSync(p) && /JWT_SECRET=/.test(fs.readFileSync(p, 'utf8'))) return;
  fs.appendFileSync(p, `JWT_SECRET=${crypto.randomBytes(48).toString('base64url')}\n`, { mode: 0o600 });
  console.log(`  Wrote random JWT_SECRET to ${p}`);
}

try {
  main();
} catch (e) {
  console.error(`generate-network failed: ${e.message}`);
  process.exit(1);
}
