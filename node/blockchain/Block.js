// node/blockchain/Block.js
const crypto = require('crypto');

class Block {
  constructor(index, transactions, previousHash, metadata = {}) {
    this.index = index;
    this.timestamp = Date.now();
    this.transactions = transactions;
    this.previousHash = previousHash;
    this.hash = '';
    this.nonce = 0;
    this.authority = null; // Node ID that created this block
    this.signature = null; // Authority signature
    this.metadata = metadata; // Additional block metadata
  }

  /**
   * Calculate block hash
   */
  calculateHash() {
    return crypto
      .createHash('sha256')
      .update(
        this.index +
        this.previousHash +
        this.timestamp +
        JSON.stringify(this.transactions) +
        this.nonce +
        (this.authority || '')
      )
      .digest('hex');
  }

  /**
   * Mine block (minimal PoW for PoA)
   */
  mineBlock(difficulty = 2) {
    const target = '0'.repeat(difficulty);
    
    while (!this.hash.startsWith(target)) {
      this.nonce++;
      this.hash = this.calculateHash();
    }

    console.log(`⛏️  Block mined: ${this.hash}`);
  }

  /**
   * Validate block structure
   */
  isValid() {
    // Check if hash is correct
    if (this.hash !== this.calculateHash()) {
      return false;
    }

    // Check if transactions are valid
    if (!Array.isArray(this.transactions)) {
      return false;
    }

    // Check index
    if (typeof this.index !== 'number' || this.index < 0) {
      return false;
    }

    return true;
  }

  /**
   * Get block size in bytes
   */
  getSize() {
    return JSON.stringify(this.toJSON()).length;
  }

  /**
   * Convert to JSON
   */
  toJSON() {
    return {
      index: this.index,
      timestamp: this.timestamp,
      transactions: this.transactions,
      previousHash: this.previousHash,
      hash: this.hash,
      nonce: this.nonce,
      authority: this.authority,
      signature: this.signature,
      metadata: this.metadata
    };
  }

  /**
   * Create block from database object
   */
  static fromDatabase(dbBlock) {
    const block = new Block(
      dbBlock.index,
      dbBlock.transactions,
      dbBlock.previousHash,
      dbBlock.metadata || {}
    );
    
    block.timestamp = dbBlock.timestamp;
    block.hash = dbBlock.hash;
    block.nonce = dbBlock.nonce;
    block.authority = dbBlock.authority;
    block.signature = dbBlock.signature;
    
    return block;
  }

  /**
   * Create block from JSON
   */
  static fromJSON(json) {
    const block = new Block(
      json.index,
      json.transactions,
      json.previousHash,
      json.metadata || {}
    );
    
    block.timestamp = json.timestamp;
    block.hash = json.hash;
    block.nonce = json.nonce;
    block.authority = json.authority;
    block.signature = json.signature;
    
    return block;
  }

  /**
   * Get block summary for display
   */
  getSummary() {
    return {
      index: this.index,
      hash: this.hash.substring(0, 16) + '...',
      previousHash: this.previousHash.substring(0, 16) + '...',
      timestamp: new Date(this.timestamp).toISOString(),
      transactionCount: this.transactions.length,
      authority: this.authority,
      size: this.getSize()
    };
  }
}

module.exports = Block;