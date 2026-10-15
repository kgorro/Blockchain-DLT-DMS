// node/test/helpers.js
// Spins up in-process ledger networks (real WebSockets, real signatures, in-memory storage).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadNetworkConfig } = require('../network/config');
const Blockchain = require('../blockchain/Blockchain');
const P2PServer = require('../p2p/P2PServer');
const Consensus = require('../consensus/Consensus');
const MemoryStore = require('../storage/MemoryStore');
const DocumentService = require('../documents/DocumentService');
const DocumentNLPProcessor = require('../nlp/DocumentNLPProcessor');
const { createTransaction } = require('../blockchain/Transaction');
const { sha256, hashObject } = require('../crypto/util');

const silent = { info() {}, warn() {}, error() {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function generateNetwork({ authorities, observers = [], roundTimeout = 600 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlt-net-'));
  const args = [path.join(__dirname, '..', 'scripts', 'generate-network.js'), '--out', dir,
    '--authorities', authorities.join(','), '--round-timeout', String(roundTimeout)];
  if (observers.length) args.push('--observers', observers.join(','));
  execFileSync(process.execPath, args, { stdio: 'ignore' });
  return dir;
}

async function startNode(dir, nodeId, { store = new MemoryStore(), withDocuments = true, log = silent } = {}) {
  const cfg = loadNetworkConfig({ nodeId, dir });
  const bc = new Blockchain({ nodeId, genesis: cfg.genesis, genesisHash: cfg.genesisHash, privateKey: cfg.privateKey, store });
  await bc.initialize();
  const p2p = new P2PServer({
    nodeId, port: 0, privateKey: cfg.privateKey, members: cfg.genesis.members,
    chainId: cfg.genesis.chainId, genesisHash: cfg.genesisHash, log
  });
  await p2p.listen();
  const consensus = new Consensus({ blockchain: bc, p2p, store, log, tickMs: 40, syncIntervalMs: 1000 });
  await consensus.start();
  let documents = null;
  let uploadsDir = null;
  if (withDocuments && cfg.role === 'authority') {
    uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), `dlt-up-${nodeId}-`));
    documents = new DocumentService({
      blockchain: bc, consensus, p2p, store, nlp: new DocumentNLPProcessor(), uploadsDir,
      nodeId, privateKey: cfg.privateKey, dataKey: cfg.dataKey, log
    });
    await documents.start();
  }
  const node = { id: nodeId, cfg, bc, p2p, consensus, documents, store, uploadsDir, running: true };
  node.stop = async () => {
    if (!node.running) return;
    node.running = false;
    consensus.stop();
    if (documents) documents.stop();
    await p2p.close();
  };
  return node;
}

function connect(a, b) {
  a.p2p.connectToPeer(`ws://127.0.0.1:${b.p2p.port}`);
}

async function waitFor(predicate, timeoutMs = 8000, stepMs = 25) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function startNetwork({ authorities = ['a', 'b', 'c', 'd'], observers = [], roundTimeout = 600 } = {}) {
  const dir = generateNetwork({ authorities, observers, roundTimeout });
  const nodes = {};
  for (const id of [...authorities, ...observers]) nodes[id] = await startNode(dir, id);
  const list = Object.values(nodes);
  for (let i = 0; i < list.length; i++) for (let j = 0; j < i; j++) connect(list[i], list[j]);
  await waitFor(() => list.every(n => n.p2p.peers.size === list.length - 1));
  return {
    dir,
    nodes,
    async stop() {
      for (const n of Object.values(nodes)) await n.stop();
    }
  };
}

let counter = 0;
function documentTx(node, overrides = {}) {
  const fileHash = overrides.fileHash || sha256(`file-${Date.now()}-${counter++}-${Math.random()}`);
  return createTransaction({
    type: 'document',
    submitter: node.id,
    privateKey: node.cfg.privateKey,
    data: {
      schema: 1,
      docId: fileHash,
      fileHash,
      category: 'academic',
      documentType: 'Transcript',
      linkedToDocument: null,
      relationshipType: null,
      recordCommitment: hashObject({ salt: Math.random() }),
      originNode: node.id,
      uploaderRef: sha256('user'),
      ...(overrides.data || {})
    }
  });
}

module.exports = { silent, sleep, generateNetwork, startNode, startNetwork, connect, waitFor, documentTx };
