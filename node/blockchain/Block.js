// node/blockchain/Block.js
//
// Block header fields are hashed; the hash is signed by the proposing authority
// (Ed25519) and finalized by a commit certificate: signatures from a quorum of
// authorities over "COMMIT|chainId|index|hash". A block without a valid certificate
// is never accepted, which is what makes history impossible to rewrite without
// compromising a quorum of authority keys.
const { hashObject, merkleRoot, sign, verify } = require('../crypto/util');

class Block {
  constructor({ chainId, index, timestamp = Date.now(), previousHash, transactions = [], proposer = null, round = 0 }) {
    this.chainId = chainId;
    this.index = index;
    this.timestamp = timestamp;
    this.previousHash = previousHash;
    this.transactions = transactions;
    this.txRoot = Block.computeTxRoot(transactions);
    this.proposer = proposer;
    this.round = round;
    this.hash = this.calculateHash();
    this.signature = null; // proposer signature over hash
    this.commits = [];     // [{ nodeId, signature }] commit certificate
  }

  static computeTxRoot(transactions) {
    return merkleRoot(transactions.map(tx => tx.id || hashObject(tx)));
  }

  header() {
    return {
      chainId: this.chainId,
      index: this.index,
      timestamp: this.timestamp,
      previousHash: this.previousHash,
      txRoot: this.txRoot,
      proposer: this.proposer,
      round: this.round
    };
  }

  calculateHash() {
    return hashObject(this.header());
  }

  static proposalMessage(hash) {
    return 'PROPOSE|' + hash;
  }

  static commitMessage(chainId, index, hash) {
    return `COMMIT|${chainId}|${index}|${hash}`;
  }

  signAsProposer(privateKey) {
    this.signature = sign(privateKey, Block.proposalMessage(this.hash));
  }

  verifyProposerSignature(publicKey) {
    return verify(publicKey, Block.proposalMessage(this.hash), this.signature);
  }

  getSize() {
    return JSON.stringify(this.toJSON()).length;
  }

  toJSON() {
    return {
      chainId: this.chainId,
      index: this.index,
      timestamp: this.timestamp,
      previousHash: this.previousHash,
      txRoot: this.txRoot,
      proposer: this.proposer,
      round: this.round,
      hash: this.hash,
      signature: this.signature,
      commits: this.commits,
      transactions: this.transactions,
      // kept for the existing frontend
      authority: this.proposer,
      nonce: 0
    };
  }

  /** Rebuild from JSON without trusting any derived field: txRoot and hash are kept as received so validation can compare them. */
  static fromJSON(json) {
    const block = Object.create(Block.prototype);
    block.chainId = json.chainId;
    block.index = json.index;
    block.timestamp = json.timestamp;
    block.previousHash = json.previousHash;
    block.transactions = Array.isArray(json.transactions) ? json.transactions : [];
    block.txRoot = json.txRoot;
    block.proposer = json.proposer;
    block.round = json.round || 0;
    block.hash = json.hash;
    block.signature = json.signature || null;
    block.commits = Array.isArray(json.commits) ? json.commits.map(c => ({ nodeId: c.nodeId, signature: c.signature })) : [];
    return block;
  }

  static fromDatabase(doc) {
    return Block.fromJSON(doc);
  }

  getSummary() {
    return {
      index: this.index,
      hash: this.hash.substring(0, 16) + '...',
      previousHash: String(this.previousHash).substring(0, 16) + '...',
      timestamp: new Date(this.timestamp).toISOString(),
      transactionCount: this.transactions.length,
      proposer: this.proposer,
      commits: this.commits.length,
      size: this.getSize()
    };
  }
}

module.exports = Block;
