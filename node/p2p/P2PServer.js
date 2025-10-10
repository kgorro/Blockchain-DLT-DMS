// node/p2p/P2PServer.js
const WebSocket = require('ws');
const Block = require('../blockchain/Block');

const MESSAGE_TYPES = {
  CHAIN_REQUEST: 'CHAIN_REQUEST',
  CHAIN_RESPONSE: 'CHAIN_RESPONSE',
  NEW_BLOCK: 'NEW_BLOCK',
  NEW_TRANSACTION: 'NEW_TRANSACTION',
  BLOCK_VOTE: 'BLOCK_VOTE',
  NODE_DISCOVERY: 'NODE_DISCOVERY',
  NODE_INFO: 'NODE_INFO',
  HEARTBEAT: 'HEARTBEAT',
  SYNC_REQUEST: 'SYNC_REQUEST'
};

class P2PServer {
  constructor(blockchain, port, nodeId) {
    this.blockchain = blockchain;
    this.port = port;
    this.nodeId = nodeId;
    this.peers = [];
    this.server = null;
    this.messageHandlers = new Map();
  }

  /**
   * Start P2P server
   */
  listen() {
    this.server = new WebSocket.Server({ port: this.port });

    this.server.on('connection', (socket, req) => {
      const clientIp = req.socket.remoteAddress;
      console.log(`🔗 New peer connected from ${clientIp}`);
      
      this.initConnection(socket);
    });

    console.log(`🌐 P2P Server listening on port ${this.port}`);

    // Start heartbeat
    this.startHeartbeat();
  }

  /**
   * Initialize connection with peer
   */
  initConnection(socket) {
    this.peers.push(socket);
    
    this.initMessageHandler(socket);
    this.initErrorHandler(socket);

    // Send node info
    this.send(socket, {
      type: MESSAGE_TYPES.NODE_INFO,
      data: {
        nodeId: this.nodeId,
        isAuthority: this.blockchain.isAuthority,
        blockCount: this.blockchain.chain.length,
        timestamp: Date.now()
      }
    });

    // Request peer's chain
    this.send(socket, {
      type: MESSAGE_TYPES.CHAIN_REQUEST,
      data: { nodeId: this.nodeId }
    });
  }

  /**
   * Initialize message handler
   */
  initMessageHandler(socket) {
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message, socket);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });
  }

  /**
   * Initialize error handler
   */
  initErrorHandler(socket) {
    socket.on('close', () => {
      console.log('🔌 Peer disconnected');
      this.peers = this.peers.filter(peer => peer !== socket);
    });

    socket.on('error', (error) => {
      console.error('❌ Socket error:', error);
      this.peers = this.peers.filter(peer => peer !== socket);
    });
  }

  /**
   * Handle incoming message
   */
  async handleMessage(message, socket) {
    // Filter out noisy messages from logging
    const quietMessages = [
      MESSAGE_TYPES.HEARTBEAT,
      MESSAGE_TYPES.NODE_INFO
    ];
    
    // Only log important messages
    if (!quietMessages.includes(message.type)) {
      console.log(`📨 Received message: ${message.type}`);
    }

    switch (message.type) {
      case MESSAGE_TYPES.CHAIN_REQUEST:
        await this.handleChainRequest(socket);
        break;

      case MESSAGE_TYPES.CHAIN_RESPONSE:
        await this.handleChainResponse(message.data);
        break;

      case MESSAGE_TYPES.NEW_BLOCK:
        await this.handleNewBlock(message.data);
        break;

      case MESSAGE_TYPES.NEW_TRANSACTION:
        await this.handleNewTransaction(message.data);
        break;

      case MESSAGE_TYPES.BLOCK_VOTE:
        await this.handleBlockVote(message.data);
        break;

      case MESSAGE_TYPES.NODE_DISCOVERY:
        await this.handleNodeDiscovery(message.data, socket);
        break;

      case MESSAGE_TYPES.NODE_INFO:
        this.handleNodeInfo(message.data, socket);
        break;

      case MESSAGE_TYPES.HEARTBEAT:
        this.handleHeartbeat(message.data, socket);
        break;

      case MESSAGE_TYPES.SYNC_REQUEST:
        await this.handleSyncRequest(socket);
        break;

      default:
        console.log(`⚠️ Unknown message type: ${message.type}`);
    }

    // Call custom handlers
    if (this.messageHandlers.has(message.type)) {
      const handler = this.messageHandlers.get(message.type);
      await handler(message.data, socket);
    }
  }

  /**
   * Handle chain request
   */
  async handleChainRequest(socket) {
    this.send(socket, {
      type: MESSAGE_TYPES.CHAIN_RESPONSE,
      data: {
        chain: this.blockchain.export().chain,
        nodeId: this.nodeId
      }
    });
  }

  /**
   * Handle chain response
   */
  async handleChainResponse(data) {
    const receivedChain = data.chain.map(blockData => Block.fromJSON(blockData));
    
    if (receivedChain.length > this.blockchain.chain.length) {
      console.log(`📊 Received longer chain (${receivedChain.length} blocks) from ${data.nodeId}`);
      await this.blockchain.replaceChain(receivedChain);
    }
  }

  /**
   * Handle new block broadcast
   */
  async handleNewBlock(data) {
    const block = Block.fromJSON(data.block);
    console.log(`📦 Received new block #${block.index} from ${data.nodeId}`);

    // Validate block
    const validation = await this.blockchain.validateBlock(block);

    if (validation.valid) {
      // Vote on block (if we're an authority)
      if (this.blockchain.isAuthority) {
        const approved = true; // In production, add more validation logic
        this.blockchain.voteOnBlock(block.hash, this.nodeId, approved);

        // Broadcast vote
        this.broadcast({
          type: MESSAGE_TYPES.BLOCK_VOTE,
          data: {
            blockHash: block.hash,
            nodeId: this.nodeId,
            vote: approved
          }
        });

        console.log(`✅ Voted ${approved ? 'YES' : 'NO'} on block ${block.hash.substring(0, 8)}...`);
      }

      // Try to add block
      const result = await this.blockchain.addBlock(block);
      
      if (result.success) {
        console.log(`✅ Block #${block.index} added to chain`);
      } else if (result.voteStatus) {
        console.log(`⏳ Block #${block.index} pending consensus (${result.voteStatus.yes}/${result.voteStatus.required})`);
      }
    } else {
      console.log(`❌ Block validation failed: ${validation.reason}`);
    }
  }

  /**
   * Handle new transaction
   */
  async handleNewTransaction(data) {
    console.log(`📝 Received new transaction from ${data.nodeId}`);
    
    try {
      this.blockchain.addTransaction(data.transaction);
      
      // If we're an authority, we might mine this transaction
      if (this.blockchain.isAuthority && this.blockchain.pendingTransactions.length >= 1) {
        // Auto-mine after receiving transaction (configurable)
        setTimeout(async () => {
          await this.mineAndBroadcast();
        }, 2000); // 2 second delay
      }
    } catch (error) {
      console.error('Error adding transaction:', error);
    }
  }

  /**
   * Handle block vote
   */
  async handleBlockVote(data) {
    console.log(`🗳️  Vote received from ${data.nodeId}: ${data.vote ? 'YES' : 'NO'} for block ${data.blockHash.substring(0, 8)}...`);
    
    const voteStatus = this.blockchain.voteOnBlock(data.blockHash, data.nodeId, data.vote);

    // If consensus reached, try to add the block
    if (voteStatus.approved) {
      // Find the block in pending blocks
      // This assumes we've stored pending blocks somewhere
      console.log(`✅ Consensus reached for block ${data.blockHash.substring(0, 8)}...`);
    }
  }

  /**
   * Handle node discovery
   */
  async handleNodeDiscovery(data, socket) {
    console.log(`🔍 Node discovery from ${data.nodeId}`);
    
    if (data.isAuthority) {
      this.blockchain.addAuthority(data.nodeId);
    }

    // Send our node info back
    this.send(socket, {
      type: MESSAGE_TYPES.NODE_INFO,
      data: {
        nodeId: this.nodeId,
        isAuthority: this.blockchain.isAuthority,
        blockCount: this.blockchain.chain.length
      }
    });
  }

  /**
   * Handle node info
   */
  handleNodeInfo(data, socket) {
    console.log(`ℹ️  Node info from ${data.nodeId}: Authority=${data.isAuthority}, Blocks=${data.blockCount}`);
    
    if (data.isAuthority) {
      this.blockchain.addAuthority(data.nodeId);
    }

    // Store socket with node ID
    socket.nodeId = data.nodeId;
  }

  /**
   * Handle heartbeat
   */
  handleHeartbeat(data, socket) {
    // Send heartbeat response
    this.send(socket, {
      type: MESSAGE_TYPES.HEARTBEAT,
      data: {
        nodeId: this.nodeId,
        timestamp: Date.now()
      }
    });
  }

  /**
   * Handle sync request
   */
  async handleSyncRequest(socket) {
    console.log('🔄 Sync request received');
    await this.handleChainRequest(socket);
  }

  /**
   * Connect to peer
   */
  connectToPeer(peerUrl) {
    const socket = new WebSocket(peerUrl);

    socket.on('open', () => {
      console.log(`✅ Connected to peer: ${peerUrl}`);
      this.initConnection(socket);
    });

    socket.on('error', (error) => {
      console.error(`❌ Connection failed to ${peerUrl}:`, error.message);
    });
  }

  /**
   * Connect to multiple peers
   */
  connectToPeers(peerUrls) {
    peerUrls.forEach(url => this.connectToPeer(url));
  }

  /**
   * Send message to specific peer
   */
  send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /**
   * Broadcast message to all peers
   */
  broadcast(message) {
    this.peers.forEach(peer => {
      if (peer.readyState === WebSocket.OPEN) {
        this.send(peer, message);
      }
    });
  }

  /**
   * Broadcast new block
   */
  broadcastNewBlock(block) {
    this.broadcast({
      type: MESSAGE_TYPES.NEW_BLOCK,
      data: {
        block: block.toJSON(),
        nodeId: this.nodeId
      }
    });
    console.log(`📢 Broadcasted new block #${block.index}`);
  }

  /**
   * Broadcast new transaction
   */
  broadcastTransaction(transaction) {
    this.broadcast({
      type: MESSAGE_TYPES.NEW_TRANSACTION,
      data: {
        transaction,
        nodeId: this.nodeId
      }
    });
    console.log('📢 Broadcasted new transaction');
  }

  /**
   * Mine and broadcast block
   */
/**
 * Mine and broadcast block
 */
async mineAndBroadcast() {
  if (!this.blockchain.isAuthority) {
    console.log('⚠️ Only authority nodes can mine blocks');
    return null;
  }

  try {
    console.log('⛏️  Mining pending transactions...');
    console.log(`📊 Current pending: ${this.blockchain.pendingTransactions.length}`);
    
    const block = await this.blockchain.minePendingTransactions();
    
    if (!block) {
      console.log('⚠️  No pending transactions to mine');
      return null;
    }

    console.log(`📦 Block created: #${block.index}`);
    
    // Vote for our own block
    this.blockchain.voteOnBlock(block.hash, this.nodeId, true);
    console.log(`🗳️  Voted YES for block ${block.hash.substring(0, 8)}...`);
    
    // Broadcast the new block
    this.broadcastNewBlock(block);
    console.log(`📢 Block #${block.index} broadcasted to network`);
    
    // Give other nodes time to vote
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Try to add block with consensus
    const result = await this.blockchain.addBlock(block);
    
    if (result.success) {
      console.log(`✅ Block #${block.index} added to chain after consensus`);
      return block;
    } else {
      console.log(`⏳ Block #${block.index} waiting for consensus: ${result.reason}`);
      
      // For single authority testing, force add the block
      if (this.blockchain.authorities.size === 1) {
        console.log('⚡ Single authority mode - adding block directly');
        this.blockchain.chain.push(block);
        await this.blockchain.saveBlockToDatabase(block);
        return block;
      }
      
      return null;
    }
  } catch (error) {
    console.error('❌ Error mining block:', error);
    console.error(error.stack);
    return null;
  }
}

  /**
   * Start heartbeat to keep connections alive
   */
  startHeartbeat() {
    setInterval(() => {
      this.broadcast({
        type: MESSAGE_TYPES.HEARTBEAT,
        data: {
          nodeId: this.nodeId,
          timestamp: Date.now()
        }
      });
    }, 30000); // Every 30 seconds
  }

  /**
   * Request blockchain sync from all peers
   */
  requestSync() {
    this.broadcast({
      type: MESSAGE_TYPES.SYNC_REQUEST,
      data: { nodeId: this.nodeId }
    });
    console.log('🔄 Requested blockchain sync from all peers');
  }

  /**
   * Register custom message handler
   */
  onMessage(messageType, handler) {
    this.messageHandlers.set(messageType, handler);
  }

  /**
   * Get network statistics
   */
  getNetworkStats() {
    return {
      connectedPeers: this.peers.length,
      activeConnections: this.peers.filter(p => p.readyState === WebSocket.OPEN).length,
      port: this.port,
      nodeId: this.nodeId
    };
  }

  /**
   * Close all connections
   */
  close() {
    this.peers.forEach(peer => peer.close());
    if (this.server) {
      this.server.close();
    }
    console.log('🔌 P2P Server closed');
  }
}

module.exports = P2PServer;