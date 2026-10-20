// node/app.js
// HTTP API for a ledger node. Built by createApp() once all components are running,
// so the same app can be exercised in tests with in-memory storage.
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { DocumentError, computeLineage } = require('./documents/DocumentService');
const { ERASURE_REASONS } = require('./blockchain/Transaction');
const { sha256, verifyMerkleProof } = require('./crypto/util');
const authRoutes = require('./routes/auth');
const { authenticate, optionalAuthenticate, isAdmin } = require('./middleware/auth');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function createApp({ blockchain, p2pServer, consensus, documents, network, nlpProcessor, nodeId, httpPort, p2pPort, tempDir }) {
  const NODE_ID = nodeId;
  const HTTP_PORT = httpPort;
  const P2P_PORT = p2pPort;

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/auth', authRoutes);

  const isAdminUser = req => !!(req.user && req.user.role === 'admin');
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Uploads land in a private temp dir with random names; the original file name never
  // touches the filesystem path. Verification uploads stay in memory.
  const diskUpload = multer({ dest: tempDir, limits: { fileSize: MAX_UPLOAD_BYTES } });
  const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

  function requireAuthorityNode(req, res, next) {
    if (documents && documents.observer) return res.status(403).json({ success: false, error: 'Observer nodes do not hold document data' });
    next();
  }

  // ============================================
  // LEDGER API (public: the ledger contains no personal data)
  // ============================================

  app.get('/api/blockchain', (req, res) => {
    res.json({ success: true, blockchain: blockchain.export(), nodeId: NODE_ID });
  });

  app.get('/api/blockchain/blocks', (req, res) => {
    const from = Math.max(0, parseInt(req.query.from, 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
    res.json({
      success: true,
      blocks: blockchain.chain.slice(from, from + limit).map(b => b.toJSON()),
      count: blockchain.chain.length
    });
  });

  app.get('/api/blockchain/block/:index', (req, res) => {
    const block = blockchain.chain[parseInt(req.params.index, 10)];
    if (!block) return res.status(404).json({ success: false, error: 'Block not found' });
    res.json({ success: true, block: block.toJSON() });
  });

  app.get('/api/blockchain/verify', asyncRoute(async (req, res) => {
    res.json({ success: true, ...(await blockchain.verifyChain()) });
  }));

  app.get('/api/blockchain/statistics', (req, res) => {
    res.json({ success: true, statistics: blockchain.getStatistics() });
  });

  app.get('/api/consensus/status', (req, res) => {
    res.json({ success: true, consensus: consensus.getStatus() });
  });

  app.get('/api/consensus/evidence', authenticate, isAdmin, asyncRoute(async (req, res) => {
    res.json({ success: true, evidence: await consensus.store.listEvidence() });
  }));

  // ============================================
  // DOCUMENT API
  // ============================================

  app.post('/api/documents/upload', requireAuthorityNode, authenticate, isAdmin, diskUpload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    try {
      if (!req.body.title) return res.status(400).json({ success: false, error: 'Document title is required' });

      const enableNLP = req.body.enableNLP === 'true' || req.body.enableNLP === true;
      const nlpData = enableNLP
        ? await nlpProcessor.processDocument(req.file.path, req.file.mimetype, req.file.originalname)
        : null;
      const fileBuffer = await fs.promises.readFile(req.file.path);

      const { tx, record, fileHash } = await documents.registerDocument({
        fileBuffer,
        file: { originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size },
        fields: req.body,
        user: req.user,
        nlpData
      });

      res.status(201).json({
        success: true,
        message: enableNLP ? 'Document registered with AI analysis; waiting for consensus' : 'Document registered; waiting for consensus',
        transaction: tx,
        document: await documents.viewByDocId(fileHash, { includePersonal: true }),
        fileHash,
        uploadedBy: req.user.username,
        nlpMetadata: record.nlpMetadata,
        nlpEnabled: record.nlpEnabled,
        manualKeywords: record.manualKeywords,
        pendingTransactions: blockchain.pending.size,
        miningLeader: blockchain.leaderFor(consensus.height, consensus.lastRound)
      });
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
  }));

  // Public verification: anyone holding a file can check it. Personal metadata is only
  // returned to authenticated admins; the public sees authenticity and ledger anchoring.
  app.post('/api/documents/verify', optionalAuthenticate, memoryUpload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const fileHash = sha256(req.file.buffer);
    const entry = blockchain.getDocumentEntry(fileHash);
    if (!entry) {
      return res.json({ success: true, isValid: false, fileHash, message: 'Document not found on the ledger. It may be altered or was never registered.' });
    }

    const proof = blockchain.getInclusionProof(fileHash);
    const block = blockchain.chain[entry.blockIndex];
    const certificate = blockchain.verifyCertificate(block);
    const includePersonal = isAdminUser(req);
    const document = documents.observer
      ? { fileHash, ...entry.tx.data, title: '[Observer node]' }
      : await documents.viewByDocId(fileHash, { includePersonal });

    res.json({
      success: true,
      isValid: true,
      fileHash,
      message: document.metadataStatus === 'erased'
        ? 'Document is authentic. Its metadata was erased under a data-subject request; the ledger keeps only the proof.'
        : 'Document verified: it matches a record finalized by the authority network.',
      blockIndex: block.index,
      blockHash: block.hash,
      finalizedBy: block.commits.map(c => c.nodeId),
      quorum: blockchain.quorum,
      certificateValid: certificate === null,
      merkleProofValid: verifyMerkleProof(proof.txId, proof.merkleProof, block.txRoot),
      document
    });
  }));

  // Guests see the ledger view (category, type, block, integrity status); admins also
  // see the decrypted metadata.
  app.get('/api/documents', requireAuthorityNode, optionalAuthenticate, asyncRoute(async (req, res) => {
    const docs = await documents.listDocuments({ includePersonal: isAdminUser(req) });
    res.json({
      success: true,
      documents: docs,
      count: docs.length,
      chainLength: blockchain.height,
      pendingCount: docs.filter(d => d.status === 'pending').length
    });
  }));

  async function searchResponse(query, filters) {
    const results = nlpProcessor.search(query, filters || {});
    const out = [];
    for (const r of results) {
      const view = await documents.viewByDocId(r.docId, { includePersonal: true });
      if (view && view.metadataStatus !== 'erased') out.push({ ...view, searchScore: r.score });
    }
    return out;
  }

  // Search runs over decrypted content, so only admins get results (otherwise result
  // ranking would leak personal data to anonymous users).
  const GUEST_SEARCH = { success: true, results: [], count: 0, message: 'Log in to search document contents' };

  app.post('/api/documents/search/advanced', requireAuthorityNode, optionalAuthenticate, asyncRoute(async (req, res) => {
    const { query, filters } = req.body;
    if (!query || !String(query).trim()) return res.status(400).json({ success: false, error: 'Search query is required' });
    if (!isAdminUser(req)) return res.json({ ...GUEST_SEARCH, query, filters });
    const results = await searchResponse(String(query), filters);
    res.json({ success: true, results, count: results.length, query, filters });
  }));

  app.get('/api/documents/search', requireAuthorityNode, optionalAuthenticate, asyncRoute(async (req, res) => {
    const query = req.query.q || req.query.query;
    if (!query || !String(query).trim()) return res.status(400).json({ success: false, error: 'Search query parameter "q" is required' });
    if (!isAdminUser(req)) return res.json({ ...GUEST_SEARCH, query });
    const results = await searchResponse(String(query), {});
    res.json({ success: true, results, count: results.length, query });
  }));

  app.get('/api/documents/related/:fileHash', requireAuthorityNode, optionalAuthenticate, asyncRoute(async (req, res) => {
    const { fileHash } = req.params;
    const opts = { includePersonal: isAdminUser(req) };
    const current = await documents.viewByDocId(fileHash, opts);
    if (!current) return res.status(404).json({ success: false, error: 'Document not found' });
    const parent = current.linkedToDocument ? await documents.viewByDocId(current.linkedToDocument, opts) : null;
    const children = [];
    for (const id of blockchain.getChildren(fileHash)) children.push(await documents.viewByDocId(id, opts));
    res.json({ success: true, current, parent, children: children.sort((a, b) => a.timestamp - b.timestamp) });
  }));

  // On-chain lineage (public, no personal data)
  app.get('/api/documents/:docId/lineage', (req, res) => {
    const lineage = computeLineage(blockchain, req.params.docId);
    if (!lineage) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({ success: true, lineage });
  });

  // Inclusion proof: lets anyone check a document's anchoring offline with the
  // authorities' public keys from genesis.json.
  app.get('/api/documents/:docId/proof', (req, res) => {
    const proof = blockchain.getInclusionProof(req.params.docId);
    if (!proof) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({
      success: true,
      proof,
      network: {
        chainId: blockchain.chainId,
        genesisHash: blockchain.genesisHash,
        authorities: network.genesis.members.filter(m => m.role === 'authority')
      }
    });
  });

  app.get('/api/documents/:docId/file', requireAuthorityNode, authenticate, isAdmin, asyncRoute(async (req, res) => {
    const { buffer, fileName, fileType } = await documents.readFile(req.params.docId);
    res.setHeader('Content-Type', fileType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }));

  app.post('/api/documents/:docId/erase', requireAuthorityNode, authenticate, isAdmin, asyncRoute(async (req, res) => {
    const reasonCode = req.body.reasonCode || 'data_subject_request';
    if (!ERASURE_REASONS.includes(reasonCode)) {
      return res.status(400).json({ success: false, error: `reasonCode must be one of: ${ERASURE_REASONS.join(', ')}` });
    }
    const tx = await documents.requestErasure(req.params.docId, reasonCode, req.user);
    res.status(202).json({
      success: true,
      message: 'Erasure submitted. Once finalized, every authority deletes the encrypted record, its key and the file.',
      transaction: tx
    });
  }));

  app.get('/api/documents/:docId', requireAuthorityNode, optionalAuthenticate, asyncRoute(async (req, res) => {
    const view = await documents.viewByDocId(req.params.docId, { includePersonal: isAdminUser(req) });
    if (!view) return res.status(404).json({ success: false, error: 'Document not found' });
    res.json({ success: true, document: view });
  }));

  // ============================================
  // NETWORK API
  // ============================================

  app.get('/api/network/status', (req, res) => {
    res.json({
      success: true,
      node: { id: NODE_ID, role: network.role, isAuthority: blockchain.isAuthority, httpPort: HTTP_PORT, p2pPort: P2P_PORT },
      network: p2pServer.getNetworkStats(),
      blockchain: blockchain.getStatistics(),
      consensus: consensus.getStatus(),
      mining: {
        currentLeader: blockchain.leaderFor(consensus.height, consensus.lastRound),
        authorityList: blockchain.authorityList
      }
    });
  });

  app.get('/api/mining/leader', (req, res) => {
    res.json({
      success: true,
      currentLeader: blockchain.leaderFor(consensus.height, consensus.lastRound),
      nextBlockIndex: blockchain.height,
      round: consensus.lastRound,
      isMyTurn: blockchain.leaderFor(consensus.height, consensus.lastRound) === NODE_ID,
      nodeId: NODE_ID,
      authorityList: blockchain.authorityList
    });
  });

  app.post('/api/network/peers', authenticate, isAdmin, (req, res) => {
    const { peerUrl } = req.body;
    if (!peerUrl || !/^wss?:\/\/[^\s]+$/.test(peerUrl)) return res.status(400).json({ success: false, error: 'A ws:// or wss:// peer URL is required' });
    p2pServer.connectToPeer(peerUrl);
    res.json({ success: true, message: `Connecting to peer: ${peerUrl} (it must be listed in genesis.json to be accepted)` });
  });

  app.post('/api/network/sync', authenticate, isAdmin, (req, res) => {
    consensus.requestSync();
    res.json({ success: true, message: 'Sync requested from all peers' });
  });

  // Consensus proposes automatically. This only nudges the engine to run now.
  app.post('/api/mine', authenticate, isAdmin, asyncRoute(async (req, res) => {
    await consensus.trigger();
    res.json({ success: true, message: 'Consensus tick triggered', consensus: consensus.getStatus() });
  }));

  app.get('/api/health', (req, res) => {
    res.json({
      status: blockchain ? 'OK' : 'STARTING',
      nodeId: NODE_ID,
      role: network.role,
      isAuthority: network.role === 'authority',
      blockCount: blockchain ? blockchain.height : 0,
      peers: p2pServer ? p2pServer.getNetworkStats().connectedPeers : 0,
      timestamp: new Date().toISOString()
    });
  });

  app.get('/api/info', (req, res) => {
    res.json({
      success: true,
      node: { id: NODE_ID, type: network.role, httpPort: HTTP_PORT, p2pPort: P2P_PORT, version: '2.0.0' },
      blockchain: blockchain ? blockchain.getStatistics() : null,
      network: p2pServer ? p2pServer.getNetworkStats() : null
    });
  });

  // Error handler (must be registered last)
  app.use((err, req, res, next) => {
    if (err instanceof DocumentError) return res.status(err.status).json({ success: false, error: err.message });
    if (err instanceof multer.MulterError) return res.status(400).json({ success: false, error: err.message });
    console.error('Error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
