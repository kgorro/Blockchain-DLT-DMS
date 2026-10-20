// node/server.js
// Entry point for one ledger node: HTTP API + P2P networking + consensus + privacy layer.
require('dotenv').config();
const mongoose = require('mongoose');
const os = require('os');
const fs = require('fs');
const path = require('path');

const Blockchain = require('./blockchain/Blockchain');
const P2PServer = require('./p2p/P2PServer');
const Consensus = require('./consensus/Consensus');
const MongoStore = require('./storage/MongoStore');
const DocumentService = require('./documents/DocumentService');
const DocumentNLPProcessor = require('./nlp/DocumentNLPProcessor');
const { loadNetworkConfig } = require('./network/config');
const { createApp } = require('./app');

// ============================================
// CONFIGURATION
// ============================================

const HTTP_PORT = Number(process.env.PORT || 5001);
const P2P_PORT = Number(process.env.P2P_PORT || 6001);
const NODE_ID = process.env.NODE_ID || `node-${HTTP_PORT}`;
const MONGODB_URI = process.env.MONGODB_URI || `mongodb://localhost:27017/blockchain-${NODE_ID}`;
const BOOTSTRAP_PEERS = process.env.BOOTSTRAP_PEERS ? process.env.BOOTSTRAP_PEERS.split(',').map(s => s.trim()).filter(Boolean) : [];
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

let network;
try {
  network = loadNetworkConfig({ nodeId: NODE_ID });
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}

if (process.env.NODE_TYPE && (process.env.NODE_TYPE === 'authority') !== (network.role === 'authority')) {
  console.warn(`⚠️  NODE_TYPE=${process.env.NODE_TYPE} is ignored: genesis.json lists ${NODE_ID} as ${network.role}`);
}

// Strip MongoDB query operators ($gt, $ne, ...) from user-supplied filter values.
mongoose.set('sanitizeFilter', true);

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `dms-${NODE_ID}-`));
const nlpProcessor = new DocumentNLPProcessor();
let blockchain;
let p2pServer;
let consensus;
let documents;

// ============================================
// STARTUP
// ============================================

async function start() {
  await mongoose.connect(MONGODB_URI);
  console.log(`✅ MongoDB connected: ${mongoose.connection.name}`);

  const store = new MongoStore(mongoose.connection);
  blockchain = new Blockchain({
    nodeId: NODE_ID,
    genesis: network.genesis,
    genesisHash: network.genesisHash,
    privateKey: network.privateKey,
    store
  });

  try {
    const init = await blockchain.initialize();
    console.log(init.created ? '✅ Genesis block created from genesis.json' : `✅ Loaded and verified ${init.blocks} blocks`);
  } catch (e) {
    if (e.code === 'LEDGER_TAMPERED') {
      console.error(`🚨 ${e.message}`);
      console.error('🚨 The local ledger database was modified outside the protocol. Refusing to start.');
      console.error('🚨 Restore from a trusted backup, or drop this node\'s ledger_blocks collection and let it re-sync from peers.');
    }
    throw e;
  }

  p2pServer = new P2PServer({
    nodeId: NODE_ID,
    port: P2P_PORT,
    privateKey: network.privateKey,
    members: network.genesis.members,
    chainId: network.genesis.chainId,
    genesisHash: network.genesisHash
  });
  await p2pServer.listen();

  consensus = new Consensus({ blockchain, p2p: p2pServer, store });
  await consensus.start();

  if (network.role === 'authority') {
    documents = new DocumentService({
      blockchain, consensus, p2p: p2pServer, store, nlp: nlpProcessor,
      uploadsDir: UPLOADS_DIR, nodeId: NODE_ID, privateKey: network.privateKey, dataKey: network.dataKey
    });
    await documents.start();
  } else {
    console.log('ℹ️  Observer node: verifies and stores the ledger, does not hold document records');
    documents = { observer: true };
  }

  if (BOOTSTRAP_PEERS.length) {
    console.log(`🔗 Connecting to peers: ${BOOTSTRAP_PEERS.join(', ')}`);
    p2pServer.connectToPeers(BOOTSTRAP_PEERS);
  }

  const app = createApp({
    blockchain, p2pServer, consensus, documents, network, nlpProcessor,
    nodeId: NODE_ID, httpPort: HTTP_PORT, p2pPort: P2P_PORT, tempDir: TEMP_DIR
  });
  app.listen(HTTP_PORT, () => {
    const g = network.genesis;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Ledger node ${NODE_ID} (${network.role})`);
    console.log(`🔌 HTTP API:  http://localhost:${HTTP_PORT}`);
    console.log(`🌐 P2P:       ws://localhost:${P2P_PORT}`);
    console.log(`⛓️  Chain:     ${g.chainId} (${blockchain.height} blocks)`);
    console.log(`👥 Authorities: ${g.authorities.join(', ')} | quorum ${g.consensus.quorum} | tolerates ${g.faultTolerance} faulty`);
    console.log(`${'='.repeat(60)}\n`);
  });
}

async function shutdown() {
  console.log('\n⚠️  Shutting down...');
  if (consensus) consensus.stop();
  if (documents && documents.stop) documents.stop();
  if (p2pServer) await p2pServer.close();
  await mongoose.connection.close();
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  start().catch(err => {
    console.error('❌ Startup failed:', err.message);
    process.exit(1);
  });
}

module.exports = { start };
