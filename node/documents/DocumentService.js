// node/documents/DocumentService.js
//
// Privacy layer: splits each document into
//   ON-CHAIN  (replicated, immutable): file hash, category/type, lineage link,
//             salted commitment to the metadata record, origin node, pseudonymous
//             uploader reference. No names, emails, OCR text or file paths.
//   OFF-CHAIN (erasable): the metadata record (title, issuer, recipient, OCR text,
//             entities, uploader...) encrypted with a random per-document key, and
//             the file itself encrypted with the same key.
//
// The per-document key is stored wrapped (encrypted with the network data key) in a
// separate collection from the records. Erasure is an on-chain transaction: when it
// commits, every node deletes the record, the wrapped key and the encrypted file
// (crypto-shredding). The ledger keeps proof that the document existed and that it
// was erased, but the personal data is gone. This reconciles the immutable ledger
// with the right to erasure/correction under the Data Privacy Act of 2012 (RA 10173).
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { createTransaction } = require('../blockchain/Transaction');
const { hashObject, sha256, randomKey, encrypt, decrypt, encryptBuffer, decryptBuffer } = require('../crypto/util');

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const STAGING_TTL_MS = 10 * 60 * 1000;

const PERSONAL_DEFAULTS = {
  title: '', issuer: 'N/A', recipient: 'N/A', department: 'N/A', referenceNumber: 'N/A',
  description: 'N/A', manualKeywords: [], fileName: '', fileSize: 0, fileType: 'application/octet-stream',
  uploadedBy: '', uploadedAt: null, nlpEnabled: false,
  nlpMetadata: {
    extractedText: '', fullTextLength: 0, extractionMethod: 'none', pageCount: 0, keywords: [],
    entities: { people: [], places: [], organizations: [], dates: [] }, summary: '', language: 'unknown',
    sentiment: 'neutral', wordCount: 0, characterCount: 0
  }
};

class DocumentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

class DocumentService {
  constructor({ blockchain, consensus, p2p, store, nlp, uploadsDir, nodeId, privateKey, dataKey, log = console }) {
    if (!dataKey) throw new Error('DocumentService needs the network data key (network/keys/data.key)');
    this.bc = blockchain;
    this.consensus = consensus;
    this.p2p = p2p;
    this.store = store;
    this.nlp = nlp;
    this.uploadsDir = uploadsDir;
    this.nodeId = nodeId;
    this.privateKey = privateKey;
    this.dataKey = dataKey;
    this.log = log;

    this.cache = new Map();   // docId -> decrypted record
    this.staging = new Map(); // docId -> { record, wrappedKey, from, at } waiting for the tx
    this.timers = [];
  }

  async start() {
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.p2p.on('message', msg => {
      if (msg.type === 'RECORD') this.onRecord(msg.data, msg.from).catch(e => this.log.error && this.log.error('Record error:', e));
      if (msg.type === 'RECORD_REQUEST') this.onRecordRequest(msg.data, msg.from).catch(e => this.log.error && this.log.error('Record request error:', e));
    });
    this.bc.on('blockCommitted', block => {
      this.onBlockCommitted(block).catch(e => this.log.error && this.log.error('Post-commit error:', e));
    });

    // Apply erasures that may have been committed while this node was offline,
    // then build the search index from what remains.
    for (const docId of this.bc.state.erasures.keys()) await this.shred(docId);
    await this.rebuildSearchIndex();

    this.timers.push(setInterval(() => this.requestMissingRecords(), 30000));
    this.timers.push(setInterval(() => this.pruneStaging(), 60000));
  }

  stop() {
    this.timers.forEach(t => clearInterval(t));
  }

  // ---------------------------------------------------------------------------
  // Keys and records
  // ---------------------------------------------------------------------------

  wrapKey(key) {
    return encrypt(this.dataKey, key);
  }

  unwrapKey(wrapped) {
    return decrypt(this.dataKey, wrapped);
  }

  uploaderRef(user) {
    return sha256(`${this.bc.chainId}:${this.nodeId}:${String(user._id || user.id || user.username)}`);
  }

  filePathFor(docId) {
    return path.join(this.uploadsDir, `${docId}.bin`);
  }

  async getDocumentKey(docId) {
    const wrapped = await this.store.getKey(docId);
    if (!wrapped) return null;
    try {
      return this.unwrapKey(wrapped);
    } catch (e) {
      return null;
    }
  }

  /** Decrypted off-chain record, or null if missing/erased/undecryptable. */
  async getRecord(docId) {
    if (this.cache.has(docId)) return this.cache.get(docId);
    const [box, key] = await Promise.all([this.store.getRecord(docId), this.getDocumentKey(docId)]);
    if (!box || !key) return null;
    try {
      const record = JSON.parse(decrypt(key, box).toString('utf8'));
      this.cache.set(docId, record);
      return record;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register an uploaded file.
   * @param {object} p
   * @param {Buffer} p.fileBuffer
   * @param {object} p.file    { originalName, mimeType, size }
   * @param {object} p.fields  form fields (title, category, ...)
   * @param {object} p.user    authenticated user
   * @param {object} p.nlpData result of the NLP processor (or defaults)
   */
  async registerDocument({ fileBuffer, file, fields, user, nlpData }) {
    const fileHash = sha256(fileBuffer);
    if (this.bc.getDocumentEntry(fileHash)) throw new DocumentError('This exact file is already registered on the ledger', 409);
    if (this.findPending(fileHash)) throw new DocumentError('This exact file is already pending registration', 409);

    const linked = fields.linkedToDocument ? String(fields.linkedToDocument).trim() : null;
    const relationshipType = linked ? (fields.relationshipType || 'related') : null;
    const manualKeywords = fields.keywords
      ? String(fields.keywords).split(',').map(k => k.trim()).filter(Boolean).slice(0, 50)
      : [];

    const record = {
      schema: 1,
      salt: crypto.randomBytes(16).toString('hex'), // prevents guessing metadata from its commitment
      title: String(fields.title).slice(0, 500),
      issuer: fields.issuer || 'N/A',
      recipient: fields.recipient || 'N/A',
      department: fields.department || 'N/A',
      referenceNumber: fields.referenceNumber || 'N/A',
      description: fields.description || 'N/A',
      manualKeywords,
      fileName: path.basename(String(file.originalName || 'document')).slice(0, 255),
      fileSize: file.size,
      fileType: file.mimeType || 'application/octet-stream',
      uploadedBy: user.username,
      uploadedByRole: user.role,
      uploadedAt: new Date().toISOString(),
      originNode: this.nodeId,
      nlpEnabled: !!nlpData && nlpData.extractionMethod !== 'disabled',
      nlpMetadata: nlpData || PERSONAL_DEFAULTS.nlpMetadata
    };

    const tx = createTransaction({
      type: 'document',
      submitter: this.nodeId,
      privateKey: this.privateKey,
      data: {
        schema: 1,
        docId: fileHash,
        fileHash,
        category: String(fields.category || 'others').slice(0, 100),
        documentType: String(fields.documentType || 'Other Document').slice(0, 100),
        linkedToDocument: linked,
        relationshipType,
        recordCommitment: hashObject(record),
        originNode: this.nodeId,
        uploaderRef: this.uploaderRef(user)
      }
    });

    // Check ledger rules before writing anything.
    const precheck = this.bc.checkTransaction(tx, this.bc.pendingView());
    if (precheck) throw new DocumentError(precheck, 400);

    const docKey = randomKey();
    const box = encrypt(docKey, Buffer.from(JSON.stringify(record)));
    const wrappedKey = this.wrapKey(docKey);
    await fsp.writeFile(this.filePathFor(fileHash), encryptBuffer(docKey, fileBuffer));
    await this.store.putKey(fileHash, wrappedKey);
    await this.store.putRecord(fileHash, box);
    this.cache.set(fileHash, record);

    const result = await this.consensus.submitTransaction(tx);
    if (!result.added) {
      await this.shred(fileHash);
      throw new DocumentError(result.reason, 400);
    }
    this.p2p.broadcast('RECORD', { docId: fileHash, record: box, wrappedKey });
    this.nlp.indexDocument(fileHash, record);
    return { tx, record, fileHash };
  }

  findPending(docId) {
    for (const tx of this.bc.pending.values()) {
      if (tx.type === 'document' && tx.data.docId === docId) return tx;
    }
    return null;
  }

  async requestErasure(docId, reasonCode, user) {
    const tx = createTransaction({
      type: 'erasure',
      submitter: this.nodeId,
      privateKey: this.privateKey,
      data: { schema: 1, targetDocId: docId, reasonCode, requestedByRef: this.uploaderRef(user) }
    });
    const result = await this.consensus.submitTransaction(tx);
    if (!result.added) throw new DocumentError(result.reason, 400);
    return tx;
  }

  // ---------------------------------------------------------------------------
  // Erasure (crypto-shredding)
  // ---------------------------------------------------------------------------

  async shred(docId) {
    await this.store.deleteKey(docId);
    await this.store.deleteRecord(docId);
    this.cache.delete(docId);
    this.staging.delete(docId);
    this.nlp.removeDocument(docId);
    try {
      await fsp.unlink(this.filePathFor(docId));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  async onBlockCommitted(block) {
    for (const tx of block.transactions) {
      if (tx.type === 'erasure') {
        await this.shred(tx.data.targetDocId);
        this.log.info && this.log.info(`Erased off-chain data for ${tx.data.targetDocId.slice(0, 12)}... (reason: ${tx.data.reasonCode})`);
      } else if (tx.type === 'document') {
        const staged = this.staging.get(tx.data.docId);
        if (staged) await this.acceptRecord(tx.data.docId, staged.record, staged.wrappedKey, tx);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Replication of encrypted records between authorities
  // ---------------------------------------------------------------------------

  async onRecord(data, from) {
    if (!data || typeof data.docId !== 'string' || !data.record || !data.wrappedKey) return;
    if (!this.bc.isAuthorityNode(from)) return;
    if (JSON.stringify(data).length > MAX_RECORD_BYTES) return;
    const docId = data.docId;
    if (this.bc.getErasure(docId)) return;
    if (await this.store.getRecord(docId)) return;

    const entry = this.bc.getDocumentEntry(docId);
    const tx = entry ? entry.tx : this.findPending(docId);
    if (!tx) {
      // Record arrived before its transaction; hold it in memory until the tx shows up.
      this.staging.set(docId, { record: data.record, wrappedKey: data.wrappedKey, from, at: Date.now() });
      return;
    }
    await this.acceptRecord(docId, data.record, data.wrappedKey, tx);
  }

  /** Persist a replicated record only if it decrypts and matches the on-chain commitment. */
  async acceptRecord(docId, box, wrappedKey, tx) {
    this.staging.delete(docId);
    try {
      const key = this.unwrapKey(wrappedKey);
      const record = JSON.parse(decrypt(key, box).toString('utf8'));
      if (hashObject(record) !== tx.data.recordCommitment) {
        this.log.warn && this.log.warn(`Rejected record for ${docId.slice(0, 12)}...: does not match on-chain commitment`);
        return false;
      }
      await this.store.putKey(docId, wrappedKey);
      await this.store.putRecord(docId, box);
      this.cache.set(docId, record);
      this.nlp.indexDocument(docId, record);
      return true;
    } catch (e) {
      this.log.warn && this.log.warn(`Rejected undecryptable record for ${docId.slice(0, 12)}...`);
      return false;
    }
  }

  async onRecordRequest(data, from) {
    if (!data || !Array.isArray(data.docIds) || !this.bc.isAuthorityNode(from)) return;
    for (const docId of data.docIds.slice(0, 50)) {
      if (this.bc.getErasure(docId)) continue;
      const [box, wrappedKey] = await Promise.all([this.store.getRecord(docId), this.store.getKey(docId)]);
      if (box && wrappedKey) this.p2p.sendTo(from, 'RECORD', { docId, record: box, wrappedKey });
    }
  }

  async requestMissingRecords() {
    const have = new Set(await this.store.listRecordIds());
    const missing = [];
    for (const docId of this.bc.state.documents.keys()) {
      if (!have.has(docId) && !this.bc.getErasure(docId)) missing.push(docId);
      if (missing.length >= 50) break;
    }
    if (missing.length) this.p2p.broadcast('RECORD_REQUEST', { docIds: missing });
  }

  pruneStaging() {
    const now = Date.now();
    for (const [docId, s] of this.staging) if (now - s.at > STAGING_TTL_MS) this.staging.delete(docId);
  }

  async rebuildSearchIndex() {
    let count = 0;
    for (const docId of this.bc.state.documents.keys()) {
      const record = await this.getRecord(docId);
      if (record) {
        this.nlp.indexDocument(docId, record);
        count++;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  /**
   * Metadata integrity of the off-chain record versus the on-chain commitment:
   *   verified    record present and matches the commitment
   *   erased      erased by an on-chain erasure transaction
   *   unavailable record not (yet) replicated to this node
   *   mismatch    record present but altered (tampering)
   */
  async integrityOf(tx) {
    if (this.bc.getErasure(tx.data.docId)) return { status: 'erased', record: null };
    const record = await this.getRecord(tx.data.docId);
    if (!record) return { status: 'unavailable', record: null };
    if (hashObject(record) !== tx.data.recordCommitment) return { status: 'mismatch', record: null };
    return { status: 'verified', record };
  }

  /** Document view. Personal fields only when includePersonal is true. */
  async view(tx, { blockIndex = 'pending', blockHash = 'pending', status = 'confirmed', includePersonal = false } = {}) {
    const d = tx.data;
    const integrity = await this.integrityOf(tx);
    const erasure = this.bc.getErasure(d.docId);
    const base = {
      docId: d.docId,
      fileHash: d.fileHash,
      category: d.category,
      documentType: d.documentType,
      linkedToDocument: d.linkedToDocument || null,
      relationshipType: d.relationshipType || null,
      linkedByDocuments: this.bc.getChildren(d.docId),
      recordCommitment: d.recordCommitment,
      originNode: d.originNode,
      submittedBy: tx.submitter,
      txId: tx.id,
      blockIndex,
      blockHash,
      timestamp: tx.timestamp,
      status,
      metadataStatus: integrity.status,
      erasedAt: erasure ? erasure.tx.timestamp : null,
      erasureReason: erasure ? erasure.tx.data.reasonCode : null
    };

    if (!includePersonal || !integrity.record) {
      const placeholder = {
        erased: '[Metadata erased]',
        unavailable: '[Metadata not available on this node]',
        mismatch: '[Metadata failed integrity check]',
        verified: '[Restricted]'
      }[integrity.status];
      return {
        ...PERSONAL_DEFAULTS,
        title: placeholder,
        uploadedAt: new Date(tx.timestamp).toISOString(),
        ...base
      };
    }
    const { salt, schema, ...personal } = integrity.record;
    return { ...PERSONAL_DEFAULTS, ...personal, ...base };
  }

  async viewByDocId(docId, opts = {}) {
    const entry = this.bc.getDocumentEntry(docId);
    if (entry) {
      const block = this.bc.chain[entry.blockIndex];
      return this.view(entry.tx, { ...opts, blockIndex: block.index, blockHash: block.hash, status: 'confirmed' });
    }
    const pending = this.findPending(docId);
    if (pending) return this.view(pending, { ...opts, status: 'pending' });
    return null;
  }

  async listDocuments(opts = {}) {
    const out = [];
    for (const [docId] of this.bc.state.documents) out.push(await this.viewByDocId(docId, opts));
    for (const tx of this.bc.pending.values()) {
      if (tx.type === 'document') out.push(await this.view(tx, { ...opts, status: 'pending' }));
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Decrypt the stored file (only on the node that received the upload). */
  async readFile(docId) {
    if (this.bc.getErasure(docId)) throw new DocumentError('Document data has been erased', 410);
    const key = await this.getDocumentKey(docId);
    if (!key) throw new DocumentError('Document key not found on this node', 404);
    let data;
    try {
      data = await fsp.readFile(this.filePathFor(docId));
    } catch (e) {
      const entry = this.bc.getDocumentEntry(docId);
      const origin = entry ? entry.tx.data.originNode : 'the origin node';
      throw new DocumentError(`File is stored on ${origin}`, 404);
    }
    const buffer = decryptBuffer(key, data);
    if (sha256(buffer) !== docId) throw new DocumentError('Stored file failed integrity check', 500);
    const record = await this.getRecord(docId);
    return { buffer, fileName: record ? record.fileName : `${docId}.bin`, fileType: record ? record.fileType : 'application/octet-stream' };
  }

  getLineage(docId) {
    return computeLineage(this.bc, docId);
  }
}

/** Walk the lineage up to the root and down to all descendants (on-chain data only). */
function computeLineage(bc, docId) {
  const ancestors = [];
  let current = bc.getDocumentEntry(docId);
  if (!current) return null;
  const seen = new Set([docId]);
  while (current.tx.data.linkedToDocument && !seen.has(current.tx.data.linkedToDocument)) {
    const parentId = current.tx.data.linkedToDocument;
    seen.add(parentId);
    const parent = bc.getDocumentEntry(parentId);
    if (!parent) break;
    ancestors.unshift({ docId: parentId, relationshipOfChild: current.tx.data.relationshipType, blockIndex: parent.blockIndex });
    current = parent;
  }
  const descendants = [];
  const queue = [docId];
  while (queue.length) {
    const id = queue.shift();
    for (const child of bc.getChildren(id)) {
      if (seen.has(child)) continue;
      seen.add(child);
      const e = bc.getDocumentEntry(child);
      descendants.push({ docId: child, parent: id, relationshipType: e.tx.data.relationshipType, blockIndex: e.blockIndex });
      queue.push(child);
    }
  }
  return { docId, ancestors, descendants };
}

module.exports = DocumentService;
module.exports.DocumentError = DocumentError;
module.exports.computeLineage = computeLineage;
