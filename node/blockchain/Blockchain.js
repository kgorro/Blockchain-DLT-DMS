// node/blockchain/Blockchain.js
const crypto = require('crypto');
const Block = require('./Block');
const BlockModel = require('../models/BlockModel');

class Blockchain {
  constructor(nodeId, isAuthority = false) {
    this.nodeId = nodeId;
    this.isAuthority = isAuthority;
    this.chain = [];
    this.pendingTransactions = [];
    this.difficulty = 2;
    this.authorities = new Set();
    this.blockVotes = new Map();
    this.authorityList = []; // Ordered list for round-robin
  }

  /**
   * Initialize blockchain from database
   */
  async initialize() {
    try {
      const blocks = await BlockModel.find().sort({ index: 1 });
      
      if (blocks.length === 0) {
        console.log('No blockchain found, creating genesis block...');
        await this.createGenesisBlock();
      } else {
        this.chain = blocks.map(b => Block.fromDatabase(b));
        console.log(`✅ Loaded ${this.chain.length} blocks from database`);
      }

      return true;
    } catch (error) {
      console.error('Error initializing blockchain:', error);
      throw error;
    }
  }

  /**
   * Create genesis block
   */
  async createGenesisBlock() {
    const genesisBlock = new Block(
      0,
      [],
      '0',
      {
        type: 'genesis',
        message: 'Distributed Blockchain Network - Genesis Block',
        timestamp: new Date().toISOString(),
        network: 'document-blockchain-dlt'
      }
    );

    genesisBlock.hash = genesisBlock.calculateHash();
    genesisBlock.authority = 'genesis';
    
    this.chain.push(genesisBlock);
    
    // Save to database
    await this.saveBlockToDatabase(genesisBlock);
    
    console.log('✅ Genesis block created');
    return genesisBlock;
  }

  /**
   * Get latest block
   */
  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  /**
     * Get the current mining leader (round-robin)
     */
  getMiningLeader() {
    if (this.authorityList.length === 0) {
      return null;
    }
    
    const latestBlock = this.getLatestBlock();
    const roundIndex = latestBlock.index % this.authorityList.length;
    return this.authorityList[roundIndex];
  }

  /**
   * Check if this node should mine the next block
   */
  isMyTurnToMine() {
    if (!this.isAuthority) return false;
    
    const leader = this.getMiningLeader();
    console.log(`🎯 Mining leader for block #${this.chain.length}: ${leader}`);
    return leader === this.nodeId;
  }

  /**
   * Add authority and update list
   */
  addAuthority(nodeId) {
    this.authorities.add(nodeId);
    this.authorityList = Array.from(this.authorities).sort(); // Deterministic order
    console.log(`✅ Authority added: ${nodeId}`);
    console.log(`📋 Authority list: ${this.authorityList.join(', ')}`);
  }

  /**
   * Remove authority node
   */
  removeAuthority(nodeId) {
    this.authorities.delete(nodeId);
    console.log(`⚠️ Authority removed: ${nodeId}`);
  }

  /**
   * Check if node is authority
   */
  isAuthorityNode(nodeId) {
    return this.authorities.has(nodeId);
  }

  /**
   * Create new block (only for authority nodes)
   */
  async createBlock(transactions, metadata = {}) {
    if (!this.isAuthority) {
      throw new Error('Only authority nodes can create blocks');
    }

    const latestBlock = this.getLatestBlock();
    const newBlock = new Block(
      latestBlock.index + 1,
      transactions,
      latestBlock.hash,
      metadata
    );

    // Sign block with authority identity
    newBlock.authority = this.nodeId;
    newBlock.hash = newBlock.calculateHash();
    
    // Add authority signature
    newBlock.signature = this.signBlock(newBlock);

    console.log(`📦 Block #${newBlock.index} created by ${this.nodeId}`);
    
    return newBlock;
  }

  /**
   * Sign block with authority private key
   */
  signBlock(block) {
    const blockData = `${block.index}${block.previousHash}${block.timestamp}${JSON.stringify(block.transactions)}`;
    return crypto
      .createHash('sha256')
      .update(blockData + this.nodeId)
      .digest('hex');
  }

  /**
   * Verify block signature
   */
  verifyBlockSignature(block) {
    const blockData = `${block.index}${block.previousHash}${block.timestamp}${JSON.stringify(block.transactions)}`;
    const expectedSignature = crypto
      .createHash('sha256')
      .update(blockData + block.authority)
      .digest('hex');
    
    return block.signature === expectedSignature;
  }

  /**
   * Validate block before adding to chain
   */
  async validateBlock(block) {
    const latestBlock = this.getLatestBlock();

    // Check block index
    if (block.index !== latestBlock.index + 1) {
      return { valid: false, reason: 'Invalid block index' };
    }

    // Check previous hash
    if (block.previousHash !== latestBlock.hash) {
      return { valid: false, reason: 'Invalid previous hash' };
    }

    // Verify hash calculation
    const calculatedHash = block.calculateHash();
    if (block.hash !== calculatedHash) {
      return { valid: false, reason: 'Invalid block hash' };
    }

    // Verify authority signature
    if (!this.verifyBlockSignature(block)) {
      return { valid: false, reason: 'Invalid authority signature' };
    }

    // Check if block creator is an authority
    if (!this.isAuthorityNode(block.authority)) {
      return { valid: false, reason: 'Block creator is not an authority' };
    }

    // Validate transactions
    for (const tx of block.transactions) {
      if (!this.validateTransaction(tx)) {
        return { valid: false, reason: 'Invalid transaction in block' };
      }
    }

    return { valid: true };
  }

  /**
   * Vote on a block (PoA consensus)
   */
  voteOnBlock(blockHash, nodeId, approve) {
    if (!this.blockVotes.has(blockHash)) {
      this.blockVotes.set(blockHash, { yes: new Set(), no: new Set() });
    }

    const votes = this.blockVotes.get(blockHash);
    
    if (approve) {
      votes.yes.add(nodeId);
      votes.no.delete(nodeId);
    } else {
      votes.no.add(nodeId);
      votes.yes.delete(nodeId);
    }

    return this.getVoteStatus(blockHash);
  }

  /**
   * Get vote status for a block
   */
  getVoteStatus(blockHash) {
    const votes = this.blockVotes.get(blockHash);
    if (!votes) return { yes: 0, no: 0, total: 0 };

    const totalAuthorities = this.authorities.size;
    const yesVotes = votes.yes.size;
    const noVotes = votes.no.size;
    const requiredVotes = Math.ceil(totalAuthorities / 2); // Majority

    return {
      yes: yesVotes,
      no: noVotes,
      total: totalAuthorities,
      required: requiredVotes,
      approved: yesVotes >= requiredVotes,
      rejected: noVotes > (totalAuthorities - requiredVotes)
    };
  }

  /**
   * Add block to chain after consensus
   */
  async addBlock(block) {
    const validation = await this.validateBlock(block);
    
    if (!validation.valid) {
      console.error(`❌ Block validation failed: ${validation.reason}`);
      return { success: false, reason: validation.reason };
    }

    // Check consensus votes
    const voteStatus = this.getVoteStatus(block.hash);
    
    if (!voteStatus.approved) {
      console.log(`⏳ Block #${block.index} waiting for consensus (${voteStatus.yes}/${voteStatus.required})`);
      return { success: false, reason: 'Awaiting consensus', voteStatus };
    }

    // Add block to chain
    this.chain.push(block);
    
    // Save to database
    await this.saveBlockToDatabase(block);
    
    // Clear votes for this block
    this.blockVotes.delete(block.hash);
    
    console.log(`✅ Block #${block.index} added to chain (consensus reached)`);
    
    return { success: true, block };
  }

  /**
   * Save block to database
   */
  async saveBlockToDatabase(block) {
    try {
      const blockData = {
        index: block.index,
        timestamp: block.timestamp,
        transactions: block.transactions,
        previousHash: block.previousHash,
        hash: block.hash,
        nonce: block.nonce,
        authority: block.authority,
        signature: block.signature,
        metadata: block.metadata
      };

      await BlockModel.create(blockData);
    } catch (error) {
      console.error('Error saving block to database:', error);
      throw error;
    }
  }

  /**
   * Validate transaction
   */
  validateTransaction(transaction) {
    // Basic validation
    if (!transaction.type || !transaction.data) {
      return false;
    }

    // Validate document hash if it's a document transaction
    if (transaction.type === 'document') {
      if (!transaction.data.fileHash || transaction.data.fileHash.length !== 64) {
        return false;
      }
    }

    return true;
  }

  /**
   * Add transaction to pending pool
   */
  addTransaction(transaction) {
    if (!this.validateTransaction(transaction)) {
      throw new Error('Invalid transaction');
    }

    this.pendingTransactions.push(transaction);
    console.log(`📝 Transaction added to pool (${this.pendingTransactions.length} pending)`);
    
    return transaction;
  }

  /**
   * Mine pending transactions into a block (for authority nodes)
   */
  async minePendingTransactions() {
    if (!this.isAuthority) {
      throw new Error('Only authority nodes can mine blocks');
    }

    if (this.pendingTransactions.length === 0) {
      return null;
    }

    const transactions = [...this.pendingTransactions];
    this.pendingTransactions = [];

    const block = await this.createBlock(transactions, {
      minedBy: this.nodeId,
      transactionCount: transactions.length
    });

    return block;
  }

  /**
   * Verify entire chain integrity
   */
  async verifyChain() {
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];

      // Verify hash
      if (currentBlock.hash !== currentBlock.calculateHash()) {
        return {
          valid: false,
          reason: `Invalid hash at block ${i}`,
          blockIndex: i
        };
      }

      // Verify link
      if (currentBlock.previousHash !== previousBlock.hash) {
        return {
          valid: false,
          reason: `Broken chain at block ${i}`,
          blockIndex: i
        };
      }

      // Verify signature
      if (!this.verifyBlockSignature(currentBlock)) {
        return {
          valid: false,
          reason: `Invalid signature at block ${i}`,
          blockIndex: i
        };
      }
    }

    return { valid: true, blockCount: this.chain.length };
  }

  /**
   * Replace chain with longer valid chain (consensus)
   */
  async replaceChain(newChain) {
    if (newChain.length <= this.chain.length) {
      console.log('⚠️ Received chain is not longer than current chain');
      return false;
    }

    // Validate new chain
    const validation = await this.validateChain(newChain);
    if (!validation.valid) {
      console.log(`❌ Received chain is invalid: ${validation.reason}`);
      return false;
    }

    console.log('🔄 Replacing chain with longer valid chain');
    this.chain = newChain;

    // Save entire chain to database
    await this.syncChainToDatabase();

    return true;
  }

  /**
   * Validate a complete chain
   */
  async validateChain(chain) {
    // Check genesis block
    const genesisBlock = chain[0];
    if (genesisBlock.index !== 0 || genesisBlock.previousHash !== '0') {
      return { valid: false, reason: 'Invalid genesis block' };
    }

    // Validate all blocks
    for (let i = 1; i < chain.length; i++) {
      const block = chain[i];
      const previousBlock = chain[i - 1];

      if (block.hash !== block.calculateHash()) {
        return { valid: false, reason: `Invalid hash at block ${i}` };
      }

      if (block.previousHash !== previousBlock.hash) {
        return { valid: false, reason: `Broken chain at block ${i}` };
      }

      if (block.index !== i) {
        return { valid: false, reason: `Invalid index at block ${i}` };
      }
    }

    return { valid: true };
  }

  /**
   * Sync chain to database
   */
  async syncChainToDatabase() {
    try {
      // Clear existing blocks
      await BlockModel.deleteMany({});

      // Save all blocks
      for (const block of this.chain) {
        await this.saveBlockToDatabase(block);
      }

      console.log('✅ Chain synced to database');
    } catch (error) {
      console.error('Error syncing chain to database:', error);
      throw error;
    }
  }

  /**
   * Get blockchain statistics
   */
  getStatistics() {
    return {
      blockCount: this.chain.length,
      latestBlock: this.getLatestBlock(),
      pendingTransactions: this.pendingTransactions.length,
      authorities: Array.from(this.authorities),
      isAuthority: this.isAuthority,
      nodeId: this.nodeId
    };
  }

  /**
   * Export blockchain
   */
  export() {
    return {
      chain: this.chain.map(block => block.toJSON()),
      authorities: Array.from(this.authorities),
      exportedAt: new Date().toISOString(),
      nodeId: this.nodeId
    };
  }
}

module.exports = Blockchain;
