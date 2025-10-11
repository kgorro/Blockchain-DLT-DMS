// node/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const Blockchain = require('./blockchain/Blockchain');
const P2PServer = require('./p2p/P2PServer');

// Initialize Express
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const authRoutes = require('./routes/auth');
const { authenticate, isAdmin, isCitizen } = require('./middleware/auth');

app.use('/api/auth', authRoutes);
// Configuration from environment
const HTTP_PORT = process.env.PORT || 5001;
const P2P_PORT = process.env.P2P_PORT || 6001;
const NODE_ID = process.env.NODE_ID || `node-${HTTP_PORT}`;
const NODE_TYPE = process.env.NODE_TYPE || 'peer';
const IS_AUTHORITY = NODE_TYPE === 'authority';
const MONGODB_URI = process.env.MONGODB_URI || `mongodb://localhost:27017/blockchain-${NODE_ID}`;
const BOOTSTRAP_PEERS = process.env.BOOTSTRAP_PEERS ? process.env.BOOTSTRAP_PEERS.split(',') : [];

// Mining lock to prevent concurrent mining
let isMiningInProgress = false;
let miningTimeout = null;

// Initialize blockchain and P2P server
let blockchain;
let p2pServer;

// MongoDB Connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  console.log(`✅ MongoDB Connected: ${mongoose.connection.name}`);
  console.log(`📊 Node ID: ${NODE_ID}`);
  console.log(`🔒 Node Type: ${IS_AUTHORITY ? 'AUTHORITY' : 'PEER'}`);
  
  // Initialize blockchain
  blockchain = new Blockchain(NODE_ID, IS_AUTHORITY);
  await blockchain.initialize();
  
  // Add this node as authority if it's an authority node
  if (IS_AUTHORITY) {
    blockchain.addAuthority(NODE_ID);
  }
  
  // Initialize P2P server
  p2pServer = new P2PServer(blockchain, P2P_PORT, NODE_ID);
  p2pServer.listen();
  
  // Connect to bootstrap peers
  if (BOOTSTRAP_PEERS.length > 0) {
    console.log(`🔗 Connecting to bootstrap peers: ${BOOTSTRAP_PEERS.join(', ')}`);
    setTimeout(() => {
      p2pServer.connectToPeers(BOOTSTRAP_PEERS);
    }, 2000);
  }

  setInterval(() => {
    if (p2pServer.peers.length > 0) {
      console.log('🔄 Periodic sync - requesting chain from peers...');
      p2pServer.requestSync();
    }
  }, 15000); // 15 seconds
  
  // Start HTTP server AFTER blockchain is initialized
  startHTTPServer();
})
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// ============================================
// AUTO-MINING FUNCTION WITH LEADER ELECTION
// ============================================

async function performAutoMining() {
  if (isMiningInProgress) {
    console.log('⚠️  Mining already in progress - skipping');
    return null;
  }

  if (!blockchain.isAuthority) {
    console.log('⚠️  Not an authority node - cannot mine');
    return null;
  }

  // 🎯 KEY CHECK: Is it this node's turn to mine?
  if (!blockchain.isMyTurnToMine()) {
    const currentLeader = blockchain.getMiningLeader();
    console.log(`⏭️  Not my turn to mine. Current leader: ${currentLeader}`);
    return null;
  }

  if (blockchain.pendingTransactions.length === 0) {
    console.log('⚠️  No pending transactions to mine');
    return null;
  }

  isMiningInProgress = true;
  console.log('\n⛏️  AUTO-MINING STARTED (My turn!)');
  console.log(`👑 Mining leader for block #${blockchain.chain.length}: ${NODE_ID}`);
  console.log(`📊 Pending transactions: ${blockchain.pendingTransactions.length}`);

  try {
    // Mine the block
    const block = await blockchain.minePendingTransactions();
    
    if (!block) {
      console.log('❌ Mining returned null');
      return null;
    }
    
    console.log(`✅ Block #${block.index} mined!`);
    console.log(`   Hash: ${block.hash.substring(0, 16)}...`);
    console.log(`   Transactions: ${block.transactions.length}`);
    
    // Vote for own block
    blockchain.voteOnBlock(block.hash, NODE_ID, true);
    console.log(`🗳️  Voted YES on block ${block.hash.substring(0, 8)}...`);
    
    // Check if block already exists (fork detection)
    const existingBlock = blockchain.chain[block.index];
    if (existingBlock) {
      if (existingBlock.hash === block.hash) {
        console.log('✅ Block already in chain - skipping');
        return null;
      } else {
        console.log('⚠️  Fork detected - discarding this block');
        console.log(`   Existing: ${existingBlock.hash.substring(0, 8)}...`);
        console.log(`   New:      ${block.hash.substring(0, 8)}...`);
        
        // Return transactions to pool
        block.transactions.forEach(tx => {
          if (!blockchain.pendingTransactions.some(t => t.timestamp === tx.timestamp)) {
            blockchain.pendingTransactions.push(tx);
          }
        });
        return null;
      }
    }
    
    // Broadcast block first
    p2pServer.broadcastNewBlock(block);
    console.log(`📢 Block broadcasted to ${p2pServer.peers.length} peer(s)`);
    
    // Wait for votes if multiple authorities
    if (blockchain.authorities.size > 1) {
      console.log('⏳ Waiting for consensus votes...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Add block to chain
    console.log('⚡ Adding block to chain...');
    blockchain.chain.push(block);
    await blockchain.saveBlockToDatabase(block);
    blockchain.blockVotes.delete(block.hash);
    
    console.log(`✅ Block #${block.index} added to chain`);
    console.log(`📊 Total blocks now: ${blockchain.chain.length}`);
    console.log('✅ AUTO-MINING COMPLETED\n');
    
    return block;
    
  } catch (error) {
    console.error('\n❌ AUTO-MINING ERROR:');
    console.error(error.message);
    console.error(error.stack);
    return null;
  } finally {
    isMiningInProgress = false;
    miningTimeout = null;
  }
}

// ============================================
// BLOCKCHAIN API ROUTES
// ============================================

app.get('/api/blockchain', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  res.json({
    success: true,
    blockchain: blockchain.export(),
    nodeId: NODE_ID
  });
});

app.get('/api/blockchain/blocks', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  res.json({
    success: true,
    blocks: blockchain.chain.map(b => b.toJSON()),
    count: blockchain.chain.length
  });
});

app.get('/api/blockchain/block/:index', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  const index = parseInt(req.params.index);
  const block = blockchain.chain.find(b => b.index === index);
  
  if (!block) {
    return res.status(404).json({ success: false, error: 'Block not found' });
  }
  
  res.json({ success: true, block: block.toJSON() });
});

app.get('/api/blockchain/verify', async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  const result = await blockchain.verifyChain();
  res.json({ success: true, ...result });
});

app.get('/api/blockchain/statistics', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  const stats = blockchain.getStatistics();
  res.json({ success: true, statistics: stats });
});

// ============================================
// DOCUMENT API ROUTES
// ============================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.post('/api/documents/upload', authenticate, isAdmin, upload.single('file'), async (req, res) => {
  if (!blockchain || !p2pServer) {
    return res.status(503).json({ 
      success: false, 
      error: 'System not ready yet. Please wait a moment.' 
    });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { title, category, documentType, issuer, recipient, department, referenceNumber, description } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, error: 'Document title is required' });
    }

    const crypto = require('crypto');
    const fs = require('fs');
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const transaction = {
      type: 'document',
      timestamp: Date.now(),
      data: {
        title,
        category: category || 'others',
        documentType: documentType || 'Other Document',
        issuer: issuer || 'N/A',
        recipient: recipient || 'N/A',
        department: department || 'N/A',
        referenceNumber: referenceNumber || 'N/A',
        description: description || 'N/A',
        fileName: req.file.originalname,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        fileHash,
        filePath: req.file.path,
        uploadedBy: req.user.username, // Changed from NODE_ID
        uploadedByRole: req.user.role,  // New field
        uploadedByEmail: req.user.email, // New field
        uploadedAt: new Date().toISOString()
      }
    };

    blockchain.addTransaction(transaction);
    console.log(`📄 Transaction added by ${req.user.username} (${req.user.role})`);

    p2pServer.broadcastTransaction(transaction);
    console.log('📢 Transaction broadcasted to network');

    res.status(201).json({
      success: true,
      message: 'Document uploaded and transaction broadcasted',
      transaction,
      fileHash,
      uploadedBy: req.user.username,
      pendingTransactions: blockchain.pendingTransactions.length,
      miningLeader: blockchain.getMiningLeader(),
      isMyTurn: blockchain.isMyTurnToMine()
    });

    if (IS_AUTHORITY && blockchain.isMyTurnToMine() && !isMiningInProgress) {
      console.log('✅ My turn to mine - scheduling auto-mine');
      
      if (miningTimeout) {
        clearTimeout(miningTimeout);
      }
      
      miningTimeout = setTimeout(async () => {
        await performAutoMining();
      }, 2000);
    } else if (!blockchain.isMyTurnToMine()) {
      console.log(`⭐️ Not my turn - ${blockchain.getMiningLeader()} will mine`);
    }

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/documents/verify', upload.single('file'), async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const crypto = require('crypto');
    const fs = require('fs');
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    fs.unlinkSync(req.file.path);

    let found = null;
    let blockIndex = null;

    for (const block of blockchain.chain) {
      for (const tx of block.transactions) {
        if (tx.data && tx.data.fileHash === fileHash) {
          found = tx;
          blockIndex = block.index;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      return res.json({
        success: true,
        isValid: false,
        message: 'Document not found in blockchain'
      });
    }

    const chainValid = await blockchain.verifyChain();

    res.json({
      success: true,
      isValid: true,
      isChainIntact: chainValid.valid,
      message: 'Document verified successfully',
      document: found.data,
      blockIndex
    });

  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/documents', async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  const documents = [];
  const documentHashes = new Set(); // Prevent duplicates
  
  // Get documents from blockchain
  blockchain.chain.forEach(block => {
    block.transactions.forEach(tx => {
      if (tx.type === 'document' && tx.data) {
        if (!documentHashes.has(tx.data.fileHash)) {
          documentHashes.add(tx.data.fileHash);
          documents.push({
            ...tx.data,
            blockIndex: block.index,
            blockHash: block.hash,
            timestamp: tx.timestamp,
            status: 'confirmed'
          });
        }
      }
    });
  });
  
  // Also check pending transactions (not yet mined)
  blockchain.pendingTransactions.forEach(tx => {
    if (tx.type === 'document' && tx.data) {
      if (!documentHashes.has(tx.data.fileHash)) {
        documentHashes.add(tx.data.fileHash);
        documents.push({
          ...tx.data,
          blockIndex: 'pending',
          blockHash: 'pending',
          timestamp: tx.timestamp,
          status: 'pending'
        });
      }
    }
  });

  console.log(`📄 Found ${documents.length} documents (${blockchain.pendingTransactions.length} pending)`);
  
  res.json({ 
    success: true, 
    documents: documents.sort((a, b) => b.timestamp - a.timestamp), // Latest first
    count: documents.length,
    chainLength: blockchain.chain.length,
    pendingCount: blockchain.pendingTransactions.length
  });
});

// ============================================
// NETWORK / P2P API ROUTES
// ============================================

app.get('/api/network/status', (req, res) => {
  if (!blockchain || !p2pServer) {
    return res.status(503).json({ success: false, error: 'System not ready yet' });
  }

  res.json({
    success: true,
    node: {
      id: NODE_ID,
      isAuthority: IS_AUTHORITY,
      httpPort: HTTP_PORT,
      p2pPort: P2P_PORT
    },
    network: p2pServer.getNetworkStats(),
    blockchain: blockchain.getStatistics(),
    mining: {
      currentLeader: blockchain.getMiningLeader(),
      isMyTurn: blockchain.isMyTurnToMine(),
      isMining: isMiningInProgress,
      authorityList: blockchain.authorityList
    }
  });
});

app.get('/api/mining/leader', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  res.json({
    success: true,
    currentLeader: blockchain.getMiningLeader(),
    nextBlockIndex: blockchain.chain.length,
    isMyTurn: blockchain.isMyTurnToMine(),
    nodeId: NODE_ID,
    authorityList: blockchain.authorityList,
    authorities: Array.from(blockchain.authorities)
  });
});

app.post('/api/network/peers', (req, res) => {
  if (!p2pServer) {
    return res.status(503).json({ success: false, error: 'P2P server not initialized yet' });
  }

  const { peerUrl } = req.body;
  
  if (!peerUrl) {
    return res.status(400).json({ success: false, error: 'Peer URL required' });
  }

  p2pServer.connectToPeer(peerUrl);
  res.json({ success: true, message: `Connecting to peer: ${peerUrl}` });
});

app.post('/api/network/sync', (req, res) => {
  if (!p2pServer) {
    return res.status(503).json({ success: false, error: 'P2P server not initialized yet' });
  }

  p2pServer.requestSync();
  res.json({ success: true, message: 'Sync requested from all peers' });
});

app.post('/api/mine', async (req, res) => {
  if (!blockchain || !p2pServer) {
    return res.status(503).json({ success: false, error: 'System not ready yet' });
  }

  if (!IS_AUTHORITY) {
    return res.status(403).json({ success: false, error: 'Only authority nodes can mine blocks' });
  }

  if (!blockchain.isMyTurnToMine()) {
    return res.status(403).json({ 
      success: false, 
      error: 'Not this node\'s turn to mine',
      currentLeader: blockchain.getMiningLeader()
    });
  }

  try {
    const block = await performAutoMining();
    
    if (!block) {
      return res.json({ success: false, message: 'No pending transactions to mine' });
    }

    res.json({
      success: true,
      message: 'Block mined and broadcasted',
      block: block.toJSON()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HEALTH & INFO ROUTES
// ============================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    nodeId: NODE_ID,
    isAuthority: IS_AUTHORITY,
    blockCount: blockchain ? blockchain.chain.length : 0,
    peers: p2pServer ? p2pServer.getNetworkStats().connectedPeers : 0,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/info', (req, res) => {
  res.json({
    success: true,
    node: {
      id: NODE_ID,
      type: IS_AUTHORITY ? 'authority' : 'peer',
      httpPort: HTTP_PORT,
      p2pPort: P2P_PORT,
      version: '1.0.0'
    },
    blockchain: blockchain ? blockchain.getStatistics() : null,
    network: p2pServer ? p2pServer.getNetworkStats() : null
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, error: err.message });
});

app.get('/api/blockchain/statistics', authenticate, (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  const stats = blockchain.getStatistics();
  res.json({ success: true, statistics: stats });
});

// Admin only: Manual mining
app.post('/api/mine', authenticate, isAdmin, async (req, res) => {
  if (!blockchain || !p2pServer) {
    return res.status(503).json({ success: false, error: 'System not ready yet' });
  }

  if (!IS_AUTHORITY) {
    return res.status(403).json({ success: false, error: 'Only authority nodes can mine blocks' });
  }

  if (!blockchain.isMyTurnToMine()) {
    return res.status(403).json({ 
      success: false, 
      error: 'Not this node\'s turn to mine',
      currentLeader: blockchain.getMiningLeader()
    });
  }

  try {
    const block = await performAutoMining();
    
    if (!block) {
      return res.json({ success: false, message: 'No pending transactions to mine' });
    }

    res.json({
      success: true,
      message: 'Block mined and broadcasted',
      block: block.toJSON(),
      minedBy: req.user.username
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start HTTP server
function startHTTPServer() {
  app.listen(HTTP_PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Node Server Started`);
    console.log(`${'='.repeat(60)}`);
    console.log(`🔌 HTTP API: http://localhost:${HTTP_PORT}`);
    console.log(`🌐 P2P Network: ws://localhost:${P2P_PORT}`);
    console.log(`🆔 Node ID: ${NODE_ID}`);
    console.log(`🔒 Authority: ${IS_AUTHORITY ? 'YES ✅' : 'NO'}`);
    console.log(`📦 Blocks: ${blockchain.chain.length}`);
    console.log(`🔗 Connected Peers: ${p2pServer.getNetworkStats().connectedPeers}`);
    if (IS_AUTHORITY) {
      console.log(`👑 Mining Leader: ${blockchain.getMiningLeader()}`);
      console.log(`🎯 My Turn: ${blockchain.isMyTurnToMine() ? 'YES ✅' : 'NO'}`);
    }
    console.log(`${'='.repeat(60)}\n`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️  Shutting down gracefully...');
  
  if (p2pServer) p2pServer.close();
  await mongoose.connection.close();
  
  console.log('✅ Server stopped');
  process.exit(0);
});

module.exports = { app, blockchain, p2pServer };