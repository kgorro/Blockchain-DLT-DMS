// node/blockchain/Blockchain.js
//
// Ledger state and validation rules. This class never decides *what* to commit
// (that is the consensus engine's job); it only checks that a block is valid and
// carries a quorum certificate before appending it.
//
// Guarantees enforced here:
//   - fixed authority set from genesis.json (no self-declared authorities)
//   - Ed25519 signatures on transactions, proposals and commit votes
//   - blocks need >= quorum commit signatures (quorum = n - f, f = floor((n-1)/3))
//   - append-only: no longest-chain replacement, no deleting stored blocks
//   - the stored chain is fully re-verified on startup, so tampering with the
//     local database is detected
const EventEmitter = require('events');
const Block = require('./Block');
const { checkTransactionShape } = require('./Transaction');
const { sign, verify, merkleProof } = require('../crypto/util');

const MAX_CLOCK_DRIFT_MS = 60 * 1000;
const MAX_ROUND = 1e6;

/** Indexes derived from committed blocks. */
class ChainState {
  constructor() {
    this.txIds = new Set();
    this.documents = new Map(); // docId -> { blockIndex, position, tx }
    this.erasures = new Map();  // docId -> { blockIndex, position, tx }
    this.children = new Map();  // parent docId -> [child docId]
  }

  /** Overlay used while validating a block or building a proposal. */
  overlay() {
    const base = this;
    const added = { txIds: new Set(), docs: new Map(), erased: new Set() };
    return {
      hasTx: id => base.txIds.has(id) || added.txIds.has(id),
      hasDoc: id => base.documents.has(id) || added.docs.has(id),
      isErased: id => base.erasures.has(id) || added.erased.has(id),
      add(tx) {
        added.txIds.add(tx.id);
        if (tx.type === 'document') added.docs.set(tx.data.docId, tx);
        if (tx.type === 'erasure') added.erased.add(tx.data.targetDocId);
      }
    };
  }

  apply(block) {
    block.transactions.forEach((tx, position) => {
      this.txIds.add(tx.id);
      if (tx.type === 'document') {
        this.documents.set(tx.data.docId, { blockIndex: block.index, position, tx });
        if (tx.data.linkedToDocument) {
          const list = this.children.get(tx.data.linkedToDocument) || [];
          list.push(tx.data.docId);
          this.children.set(tx.data.linkedToDocument, list);
        }
      } else if (tx.type === 'erasure') {
        this.erasures.set(tx.data.targetDocId, { blockIndex: block.index, position, tx });
      }
    });
  }
}

class Blockchain extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.nodeId
   * @param {object} opts.genesis   normalized genesis (network/config.js)
   * @param {string} opts.genesisHash
   * @param {string} opts.privateKey this node's Ed25519 private key (PEM)
   * @param {object} opts.store     persistence (storage/MongoStore or MemoryStore)
   */
  constructor({ nodeId, genesis, genesisHash, privateKey, store }) {
    super();
    this.nodeId = nodeId;
    this.genesis = genesis;
    this.genesisHash = genesisHash;
    this.chainId = genesis.chainId;
    this.privateKey = privateKey;
    this.store = store;

    this.members = new Map(genesis.members.map(m => [m.nodeId, m]));
    this.authorityList = genesis.authorities; // sorted, deterministic
    this.authorities = new Set(this.authorityList);
    this.quorum = genesis.consensus.quorum;
    this.faultTolerance = genesis.faultTolerance;
    this.isAuthority = this.authorities.has(nodeId);

    this.chain = [];
    this.state = new ChainState();
    this.pending = new Map(); // id -> tx (insertion ordered)
    this.pendingDocs = new Set();
    this.pendingErasures = new Set();
  }

  // ---------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------

  publicKeyOf(nodeId) {
    const m = this.members.get(nodeId);
    return m ? m.publicKey : null;
  }

  authorityKeyOf(nodeId) {
    return this.authorities.has(nodeId) ? this.publicKeyOf(nodeId) : null;
  }

  isAuthorityNode(nodeId) {
    return this.authorities.has(nodeId);
  }

  /** Round-robin proposer for (height, round). */
  leaderFor(height, round = 0) {
    return this.authorityList[(height + round) % this.authorityList.length];
  }

  get height() {
    return this.chain.length;
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  buildGenesisBlock() {
    // Deterministic on every node: binds the chain to the exact network definition.
    return new Block({
      chainId: this.chainId,
      index: 0,
      timestamp: this.genesis.createdAt,
      previousHash: this.genesisHash,
      transactions: [],
      proposer: null,
      round: 0
    });
  }

  async initialize() {
    const stored = await this.store.loadBlocks();
    if (stored.length === 0) {
      const genesis = this.buildGenesisBlock();
      await this.store.appendBlock(genesis.toJSON());
      this.chain = [genesis];
      this.state = new ChainState();
      return { created: true, blocks: 1 };
    }

    const blocks = stored.map(b => Block.fromJSON(b));
    const result = this.verifyBlocks(blocks);
    if (!result.valid) {
      const err = new Error(`Stored ledger failed verification at block ${result.blockIndex}: ${result.reason}`);
      err.code = 'LEDGER_TAMPERED';
      throw err;
    }
    this.chain = blocks;
    this.state = result.state;
    return { created: false, blocks: blocks.length };
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  /** Validate a transaction against stateless rules plus the given state view. */
  checkTransaction(tx, view) {
    const shapeError = checkTransactionShape(tx, id => this.authorityKeyOf(id));
    if (shapeError) return shapeError;
    if (view.hasTx(tx.id)) return 'Transaction already committed';

    if (tx.type === 'document') {
      if (view.hasDoc(tx.data.docId)) return 'Document is already registered';
      const parent = tx.data.linkedToDocument;
      if (parent && !view.hasDoc(parent)) return 'Linked parent document does not exist on the ledger';
    }
    if (tx.type === 'erasure') {
      if (!view.hasDoc(tx.data.targetDocId)) return 'Erasure target does not exist on the ledger';
      if (view.isErased(tx.data.targetDocId)) return 'Document metadata already erased';
    }
    return null;
  }

  /** View of committed state plus the pending pool (used to admit new transactions). */
  pendingView() {
    const state = this.state;
    return {
      hasTx: id => state.txIds.has(id) || this.pending.has(id),
      hasDoc: id => state.documents.has(id) || this.pendingDocs.has(id),
      isErased: id => state.erasures.has(id) || this.pendingErasures.has(id),
      add() {}
    };
  }

  /** Add to the local pending pool (from API or peers). Returns { added, reason }. */
  addPendingTransaction(tx) {
    if (tx && this.pending.has(tx.id)) return { added: false, reason: 'Already pending' };
    const error = this.checkTransaction(tx, this.pendingView());
    if (error) return { added: false, reason: error };
    this.pending.set(tx.id, tx);
    if (tx.type === 'document') this.pendingDocs.add(tx.data.docId);
    if (tx.type === 'erasure') this.pendingErasures.add(tx.data.targetDocId);
    return { added: true };
  }

  removePending(id) {
    const tx = this.pending.get(id);
    if (!tx) return;
    this.pending.delete(id);
    if (tx.type === 'document') this.pendingDocs.delete(tx.data.docId);
    if (tx.type === 'erasure') this.pendingErasures.delete(tx.data.targetDocId);
  }

  /** Pick valid pending transactions for the next block (drops ones made invalid by commits). */
  selectTransactionsForBlock(max = this.genesis.consensus.maxTransactionsPerBlock) {
    const view = this.state.overlay();
    const selected = [];
    for (const [id, tx] of this.pending) {
      if (selected.length >= max) break;
      const error = this.checkTransaction(tx, view);
      if (error) {
        this.removePending(id);
        continue;
      }
      view.add(tx);
      selected.push(tx);
    }
    return selected;
  }

  get pendingTransactions() {
    return Array.from(this.pending.values());
  }

  // ---------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------

  createProposal(transactions, round) {
    if (!this.isAuthority) throw new Error('Only authority nodes can propose blocks');
    const prev = this.getLatestBlock();
    const block = new Block({
      chainId: this.chainId,
      index: prev.index + 1,
      timestamp: Math.max(Date.now(), prev.timestamp),
      previousHash: prev.hash,
      transactions,
      proposer: this.nodeId,
      round
    });
    block.signAsProposer(this.privateKey);
    return block;
  }

  /**
   * Structural validation of a proposal or committed block against a given tip.
   * Does not check the commit certificate.
   */
  validateBlockAgainst(block, prev, state, { checkDrift = true } = {}) {
    if (block.chainId !== this.chainId) return 'Wrong chain id';
    if (block.index !== prev.index + 1) return 'Invalid block index';
    if (block.previousHash !== prev.hash) return 'Invalid previous hash';
    if (typeof block.timestamp !== 'number' || block.timestamp < prev.timestamp) return 'Invalid timestamp';
    if (checkDrift && block.timestamp > Date.now() + MAX_CLOCK_DRIFT_MS) return 'Timestamp too far in the future';
    if (!Number.isInteger(block.round) || block.round < 0 || block.round > MAX_ROUND) return 'Invalid round';
    if (block.txRoot !== Block.computeTxRoot(block.transactions)) return 'Transaction root mismatch';
    if (block.hash !== block.calculateHash()) return 'Invalid block hash';

    if (!this.authorities.has(block.proposer)) return 'Proposer is not an authority';
    if (block.proposer !== this.leaderFor(block.index, block.round)) return 'Proposer is not the leader for this height and round';
    if (!block.verifyProposerSignature(this.publicKeyOf(block.proposer))) return 'Invalid proposer signature';

    if (block.transactions.length > this.genesis.consensus.maxTransactionsPerBlock) return 'Too many transactions';
    const view = state.overlay();
    for (const tx of block.transactions) {
      const error = this.checkTransaction(tx, view);
      if (error) return `Invalid transaction ${String(tx && tx.id).slice(0, 12)}: ${error}`;
      view.add(tx);
    }
    return null;
  }

  validateProposal(block) {
    return this.validateBlockAgainst(block, this.getLatestBlock(), this.state);
  }

  verifyCommitSignature(block, commit) {
    const key = this.authorityKeyOf(commit.nodeId);
    return !!key && verify(key, Block.commitMessage(this.chainId, block.index, block.hash), commit.signature);
  }

  /** Checks the commit certificate: >= quorum distinct authorities, all signatures valid. */
  verifyCertificate(block) {
    const seen = new Set();
    for (const c of block.commits) {
      if (seen.has(c.nodeId)) return 'Duplicate signer in certificate';
      if (!this.verifyCommitSignature(block, c)) return `Invalid commit signature from ${c.nodeId}`;
      seen.add(c.nodeId);
    }
    if (seen.size < this.quorum) return `Certificate has ${seen.size} signatures, quorum is ${this.quorum}`;
    return null;
  }

  signCommit(block) {
    return sign(this.privateKey, Block.commitMessage(this.chainId, block.index, block.hash));
  }

  /** Append a finalized block. Rejects anything without a valid certificate. */
  async appendCommittedBlock(block, { checkDrift = true } = {}) {
    const structural = this.validateBlockAgainst(block, this.getLatestBlock(), this.state, { checkDrift });
    if (structural) return { success: false, reason: structural };
    const cert = this.verifyCertificate(block);
    if (cert) return { success: false, reason: cert };

    await this.store.appendBlock(block.toJSON());
    this.chain.push(block);
    this.state.apply(block);
    for (const tx of block.transactions) this.removePending(tx.id);
    // Drop pending transactions that this block made invalid (e.g. same file registered elsewhere)
    for (const [id, tx] of this.pending) {
      if (this.state.txIds.has(id)
        || (tx.type === 'document' && this.state.documents.has(tx.data.docId))
        || (tx.type === 'erasure' && this.state.erasures.has(tx.data.targetDocId))) {
        this.removePending(id);
      }
    }
    this.emit('blockCommitted', block);
    return { success: true, block };
  }

  /** Re-verify a sequence of blocks from genesis. Returns { valid, state } or { valid:false, reason, blockIndex }. */
  verifyBlocks(blocks) {
    if (blocks.length === 0) return { valid: false, reason: 'Empty chain', blockIndex: 0 };
    const genesis = this.buildGenesisBlock();
    const g = blocks[0];
    if (g.hash !== genesis.hash || g.previousHash !== this.genesisHash || g.transactions.length !== 0) {
      return { valid: false, reason: 'Genesis block does not match genesis.json', blockIndex: 0 };
    }
    const state = new ChainState();
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      const error = this.validateBlockAgainst(block, blocks[i - 1], state, { checkDrift: false })
        || this.verifyCertificate(block);
      if (error) return { valid: false, reason: error, blockIndex: i };
      state.apply(block);
    }
    return { valid: true, state, blockCount: blocks.length };
  }

  /** Full verification of the in-memory chain (used by /api/blockchain/verify). */
  async verifyChain() {
    const result = this.verifyBlocks(this.chain);
    if (!result.valid) return { valid: false, reason: result.reason, blockIndex: result.blockIndex };
    return { valid: true, blockCount: this.chain.length };
  }

  // ---------------------------------------------------------------------------
  // Document queries (on-chain data only)
  // ---------------------------------------------------------------------------

  getDocumentEntry(docId) {
    return this.state.documents.get(docId) || null;
  }

  getErasure(docId) {
    return this.state.erasures.get(docId) || null;
  }

  getChildren(docId) {
    return this.state.children.get(docId) || [];
  }

  /** Merkle inclusion proof that a transaction is in a committed block, plus the block certificate. */
  getInclusionProof(docId) {
    const entry = this.getDocumentEntry(docId);
    if (!entry) return null;
    const block = this.chain[entry.blockIndex];
    const leaves = block.transactions.map(tx => tx.id);
    return {
      transaction: entry.tx,
      txId: entry.tx.id,
      merkleProof: merkleProof(leaves, entry.position),
      blockHeader: { ...block.header(), hash: block.hash },
      proposerSignature: block.signature,
      commits: block.commits,
      quorum: this.quorum
    };
  }

  // ---------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------

  getMiningLeader() {
    return this.leaderFor(this.height, 0);
  }

  getStatistics() {
    return {
      blockCount: this.chain.length,
      latestBlock: this.getLatestBlock() ? this.getLatestBlock().toJSON() : null,
      pendingTransactions: this.pending.size,
      documents: this.state.documents.size,
      erasures: this.state.erasures.size,
      authorities: this.authorityList,
      quorum: this.quorum,
      faultTolerance: this.faultTolerance,
      isAuthority: this.isAuthority,
      nodeId: this.nodeId,
      chainId: this.chainId
    };
  }

  export() {
    return {
      chainId: this.chainId,
      genesisHash: this.genesisHash,
      chain: this.chain.map(block => block.toJSON()),
      authorities: this.authorityList,
      quorum: this.quorum,
      exportedAt: new Date().toISOString(),
      nodeId: this.nodeId
    };
  }
}

module.exports = Blockchain;
module.exports.ChainState = ChainState;
