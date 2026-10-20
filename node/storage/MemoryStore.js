// node/storage/MemoryStore.js
// In-memory implementation of the storage interface. Used by tests and benchmarks.
// MongoStore implements the same methods for production.
class MemoryStore {
  constructor() {
    this.blocks = [];
    this.locks = new Map();
    this.records = new Map();
    this.keys = new Map();
    this.evidence = [];
  }

  // Ledger blocks (append-only)
  async loadBlocks() { return this.blocks.map(b => JSON.parse(JSON.stringify(b))); }
  async appendBlock(block) {
    if (this.blocks.some(b => b.index === block.index)) throw new Error(`Block ${block.index} already stored`);
    this.blocks.push(JSON.parse(JSON.stringify(block)));
  }

  // Consensus state per height (accepted proposals, prepared block), survives restarts
  async getLock(height) { const v = this.locks.get(height); return v ? JSON.parse(JSON.stringify(v)) : null; }
  async setLock(height, state) { this.locks.set(height, JSON.parse(JSON.stringify(state))); }

  // Encrypted off-chain records
  async putRecord(docId, record) { this.records.set(docId, record); }
  async getRecord(docId) { return this.records.get(docId) || null; }
  async deleteRecord(docId) { this.records.delete(docId); }
  async listRecordIds() { return Array.from(this.records.keys()); }

  // Wrapped per-document keys (kept apart from records so erasure can destroy them)
  async putKey(docId, wrappedKey) { this.keys.set(docId, wrappedKey); }
  async getKey(docId) { return this.keys.get(docId) || null; }
  async deleteKey(docId) { this.keys.delete(docId); }

  // Misbehaviour evidence (equivocation, conflicting certificates)
  async addEvidence(item) { this.evidence.push(item); }
  async listEvidence() { return this.evidence.slice(); }
}

module.exports = MemoryStore;
