// node/blockchain/Transaction.js
// Signed ledger transactions.
//
// Every transaction is signed by the authority node that submitted it, so the ledger
// records which institution vouched for each entry (non-repudiation). The id is the
// hash of the signed content, which also gives replay protection: the same id can
// only be committed once.
const { hashObject, sign, verify } = require('../crypto/util');

/**
 * Fields allowed on-chain for each transaction type. Anything else is rejected by
 * consensus, which keeps personal data (names, emails, OCR text, file paths) off the
 * replicated, immutable ledger. Personal data lives in the encrypted off-chain store.
 */
const ON_CHAIN_SCHEMA = {
  document: ['schema', 'docId', 'fileHash', 'category', 'documentType', 'linkedToDocument',
    'relationshipType', 'recordCommitment', 'originNode', 'uploaderRef'],
  erasure: ['schema', 'targetDocId', 'reasonCode', 'requestedByRef']
};

// Matches the options offered by the frontend upload form.
const RELATIONSHIP_TYPES = ['related', 'follows', 'supports', 'amends', 'cancels'];
const ERASURE_REASONS = ['data_subject_request', 'inaccurate_data', 'retention_expired', 'legal_order', 'other'];
const HEX64 = /^[0-9a-f]{64}$/;

function signingPayload(tx) {
  return { type: tx.type, timestamp: tx.timestamp, submitter: tx.submitter, data: tx.data };
}

function computeTxId(tx) {
  return hashObject(signingPayload(tx));
}

function createTransaction({ type, data, submitter, privateKey, timestamp = Date.now() }) {
  const tx = { type, timestamp, submitter, data };
  tx.id = computeTxId(tx);
  tx.signature = sign(privateKey, 'TX|' + tx.id);
  return tx;
}

/** Stateless checks: id, signature, schema. Stateful checks live in Blockchain. */
function checkTransactionShape(tx, publicKeyOf) {
  if (!tx || typeof tx !== 'object') return 'Transaction is not an object';
  if (!ON_CHAIN_SCHEMA[tx.type]) return `Unknown transaction type: ${tx.type}`;
  if (typeof tx.timestamp !== 'number') return 'Missing timestamp';
  if (!tx.data || typeof tx.data !== 'object') return 'Missing data';
  if (tx.id !== computeTxId(tx)) return 'Transaction id does not match its content';

  const publicKey = publicKeyOf(tx.submitter);
  if (!publicKey) return `Submitter ${tx.submitter} is not an authority`;
  if (!verify(publicKey, 'TX|' + tx.id, tx.signature)) return 'Invalid transaction signature';

  const allowed = ON_CHAIN_SCHEMA[tx.type];
  const extra = Object.keys(tx.data).filter(k => !allowed.includes(k));
  if (extra.length) return `Fields not allowed on-chain: ${extra.join(', ')}`;

  const d = tx.data;
  if (tx.type === 'document') {
    if (!HEX64.test(d.fileHash || '')) return 'fileHash must be a SHA-256 hex digest';
    if (d.docId !== d.fileHash) return 'docId must equal fileHash';
    if (!HEX64.test(d.recordCommitment || '')) return 'recordCommitment must be a SHA-256 hex digest';
    if (d.linkedToDocument != null && !HEX64.test(d.linkedToDocument)) return 'linkedToDocument must be a document id';
    if (d.linkedToDocument != null && !RELATIONSHIP_TYPES.includes(d.relationshipType)) {
      return `relationshipType must be one of: ${RELATIONSHIP_TYPES.join(', ')}`;
    }
    if (d.linkedToDocument == null && d.relationshipType != null) return 'relationshipType given without linkedToDocument';
    for (const k of ['category', 'documentType']) {
      if (typeof d[k] !== 'string' || d[k].length > 100) return `${k} must be a short string`;
    }
  }
  if (tx.type === 'erasure') {
    if (!HEX64.test(d.targetDocId || '')) return 'targetDocId must be a document id';
    if (!ERASURE_REASONS.includes(d.reasonCode)) return `reasonCode must be one of: ${ERASURE_REASONS.join(', ')}`;
  }
  return null;
}

module.exports = {
  createTransaction,
  computeTxId,
  checkTransactionShape,
  ON_CHAIN_SCHEMA,
  RELATIONSHIP_TYPES,
  ERASURE_REASONS
};
