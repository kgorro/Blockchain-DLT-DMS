// node/storage/MongoStore.js
// MongoDB implementation of the storage interface (see MemoryStore for the contract).
const mongoose = require('mongoose');

const blockSchema = new mongoose.Schema({
  chainId: String,
  index: { type: Number, required: true, unique: true },
  timestamp: Number,
  previousHash: String,
  txRoot: String,
  proposer: String,
  round: Number,
  hash: { type: String, required: true, unique: true },
  signature: String,
  commits: [{ _id: false, nodeId: String, signature: String }],
  transactions: { type: Array, default: [] }
}, { versionKey: false, minimize: false });

// Consensus state per height (accepted proposals, prepared block) so a restarted
// authority never contradicts the votes it already sent.
const lockSchema = new mongoose.Schema({
  height: { type: Number, unique: true },
  state: mongoose.Schema.Types.Mixed
}, { versionKey: false, minimize: false });

const recordSchema = new mongoose.Schema({
  docId: { type: String, unique: true },
  record: mongoose.Schema.Types.Mixed
}, { versionKey: false, minimize: false });

const keySchema = new mongoose.Schema({
  docId: { type: String, unique: true },
  wrappedKey: mongoose.Schema.Types.Mixed
}, { versionKey: false, minimize: false });

const evidenceSchema = new mongoose.Schema({
  item: mongoose.Schema.Types.Mixed,
  recordedAt: { type: Date, default: Date.now }
}, { versionKey: false });

function strip(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

class MongoStore {
  constructor(connection = mongoose.connection) {
    this.Block = connection.models.LedgerBlock || connection.model('LedgerBlock', blockSchema, 'ledger_blocks');
    this.Lock = connection.models.ConsensusLock || connection.model('ConsensusLock', lockSchema, 'consensus_locks');
    this.Record = connection.models.OffChainRecord || connection.model('OffChainRecord', recordSchema, 'document_records');
    this.Key = connection.models.DocumentKey || connection.model('DocumentKey', keySchema, 'document_keys');
    this.Evidence = connection.models.Evidence || connection.model('Evidence', evidenceSchema, 'consensus_evidence');
  }

  async loadBlocks() {
    const docs = await this.Block.find().sort({ index: 1 }).lean();
    return docs.map(strip);
  }

  async appendBlock(block) {
    const { authority, nonce, ...doc } = block;
    await this.Block.create(doc);
  }

  async getLock(height) {
    const doc = await this.Lock.findOne({ height }).lean();
    return doc ? doc.state : null;
  }

  async setLock(height, state) {
    await this.Lock.updateOne({ height }, { $set: { state } }, { upsert: true });
  }

  async putRecord(docId, record) {
    await this.Record.updateOne({ docId }, { $set: { record } }, { upsert: true });
  }

  async getRecord(docId) {
    const doc = await this.Record.findOne({ docId }).lean();
    return doc ? doc.record : null;
  }

  async deleteRecord(docId) {
    await this.Record.deleteOne({ docId });
  }

  async listRecordIds() {
    const docs = await this.Record.find({}, { docId: 1 }).lean();
    return docs.map(d => d.docId);
  }

  async putKey(docId, wrappedKey) {
    await this.Key.updateOne({ docId }, { $set: { wrappedKey } }, { upsert: true });
  }

  async getKey(docId) {
    const doc = await this.Key.findOne({ docId }).lean();
    return doc ? doc.wrappedKey : null;
  }

  async deleteKey(docId) {
    await this.Key.deleteOne({ docId });
  }

  async addEvidence(item) {
    await this.Evidence.create({ item });
  }

  async listEvidence() {
    const docs = await this.Evidence.find().sort({ recordedAt: -1 }).limit(200).lean();
    return docs.map(d => ({ ...d.item, recordedAt: d.recordedAt }));
  }
}

module.exports = MongoStore;
