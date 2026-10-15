// Privacy layer: personal data stays off-chain, is replicated encrypted, verified
// against the on-chain commitment, and can be erased (crypto-shredding) by consensus.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startNetwork, waitFor } = require('./helpers');
const { encrypt, randomKey } = require('../crypto/util');

const ADMIN = { _id: 'u1', username: 'registrar', role: 'admin' };

async function register(node, content, fields = {}) {
  return node.documents.registerDocument({
    fileBuffer: Buffer.from(content),
    file: { originalName: 'tor.txt', mimeType: 'text/plain', size: content.length },
    fields: { title: 'Transcript of Records - Juan Dela Cruz', issuer: 'Registrar', recipient: 'Juan Dela Cruz', category: 'academic', documentType: 'Transcript', ...fields },
    user: ADMIN,
    nlpData: null
  });
}

test('personal data never reaches the ledger; encrypted records replicate and verify', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const nodes = Object.values(net.nodes);
  const { a, b } = net.nodes;
  const { fileHash } = await register(a, 'TOR content 1');
  assert.ok(await waitFor(() => nodes.every(n => n.bc.getDocumentEntry(fileHash))));

  const ledgerText = JSON.stringify(b.bc.export());
  for (const secret of ['Juan Dela Cruz', 'Transcript of Records', 'registrar', 'tor.txt']) {
    assert.equal(ledgerText.includes(secret), false, `"${secret}" must not appear on-chain`);
  }

  // Off-chain record is stored encrypted on every authority...
  assert.ok(await waitFor(async () => (await Promise.all(nodes.map(n => n.store.getRecord(fileHash)))).every(Boolean)));
  const raw = JSON.stringify(await b.store.getRecord(fileHash));
  assert.equal(raw.includes('Juan'), false, 'stored record is ciphertext');

  // ...and decrypts to metadata matching the on-chain commitment.
  const view = await b.documents.viewByDocId(fileHash, { includePersonal: true });
  assert.equal(view.metadataStatus, 'verified');
  assert.equal(view.recipient, 'Juan Dela Cruz');

  const guestView = await b.documents.viewByDocId(fileHash, { includePersonal: false });
  assert.equal(guestView.recipient, 'N/A');
  assert.equal(guestView.title, '[Restricted]');
});

test('tampering with an off-chain record is detected through the commitment', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const { a, c } = net.nodes;
  const { fileHash } = await register(a, 'TOR content 2');
  assert.ok(await waitFor(async () => c.bc.getDocumentEntry(fileHash) && await c.store.getRecord(fileHash)));

  // An insider with DB access replaces the record (re-encrypting with a valid key so it still decrypts)
  const forgedKey = randomKey();
  const forged = { ...(await c.documents.getRecord(fileHash)), recipient: 'Someone Else' };
  await c.store.putKey(fileHash, c.documents.wrapKey(forgedKey));
  await c.store.putRecord(fileHash, encrypt(forgedKey, Buffer.from(JSON.stringify(forged))));
  c.documents.cache.delete(fileHash);

  const view = await c.documents.viewByDocId(fileHash, { includePersonal: true });
  assert.equal(view.metadataStatus, 'mismatch');
  assert.notEqual(view.recipient, 'Someone Else');
});

test('replicated records that do not match the commitment are refused', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const { a, d } = net.nodes;
  const { fileHash } = await register(a, 'TOR content 3');
  assert.ok(await waitFor(() => d.bc.getDocumentEntry(fileHash)));
  await d.store.deleteRecord(fileHash);
  await d.store.deleteKey(fileHash);
  d.documents.cache.delete(fileHash);

  // A malicious authority pushes a fake record for that document
  const key = randomKey();
  const accepted = await d.documents.acceptRecord(fileHash, encrypt(key, Buffer.from('{"title":"fake"}')), d.documents.wrapKey(key), d.bc.getDocumentEntry(fileHash).tx);
  assert.equal(accepted, false);
  assert.equal(await d.store.getRecord(fileHash), null);
});

test('erasure by consensus shreds the record, key and file on every node but keeps the proof', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const nodes = Object.values(net.nodes);
  const { a, b } = net.nodes;
  const { fileHash } = await register(a, 'TOR content 4');
  assert.ok(await waitFor(async () => (await Promise.all(nodes.map(n => n.store.getRecord(fileHash)))).every(Boolean)));
  assert.ok(fs.existsSync(a.documents.filePathFor(fileHash)));

  await b.documents.requestErasure(fileHash, 'data_subject_request', ADMIN);
  assert.ok(await waitFor(() => nodes.every(n => n.bc.getErasure(fileHash))), 'erasure finalized');
  assert.ok(await waitFor(async () => {
    for (const n of nodes) {
      if (await n.store.getRecord(fileHash) || await n.store.getKey(fileHash)) return false;
    }
    return true;
  }), 'record and key deleted everywhere');
  assert.equal(fs.existsSync(a.documents.filePathFor(fileHash)), false, 'encrypted file deleted at origin');

  for (const n of nodes) {
    const view = await n.documents.viewByDocId(fileHash, { includePersonal: true });
    assert.equal(view.metadataStatus, 'erased');
    assert.equal(view.title, '[Metadata erased]');
    assert.equal((await n.bc.verifyChain()).valid, true, 'ledger still verifies');
    assert.ok(n.bc.getInclusionProof(fileHash), 'existence proof kept');
  }
  await assert.rejects(a.documents.readFile(fileHash), /erased/);
  await assert.rejects(b.documents.requestErasure(fileHash, 'other', ADMIN), /already erased/);
});

test('document lineage links are recorded on-chain', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const { a, c } = net.nodes;
  const parent = await register(a, 'Purchase request');
  assert.ok(await waitFor(() => c.bc.getDocumentEntry(parent.fileHash)));
  const child = await register(a, 'Purchase order', { linkedToDocument: parent.fileHash, relationshipType: 'follows' });
  assert.ok(await waitFor(() => c.bc.getDocumentEntry(child.fileHash)));
  const grandchild = await register(c, 'Amended purchase order', { linkedToDocument: child.fileHash, relationshipType: 'amends' });
  assert.ok(await waitFor(() => a.bc.getDocumentEntry(grandchild.fileHash)));

  const lineage = a.documents.getLineage(grandchild.fileHash);
  assert.deepEqual(lineage.ancestors.map(x => x.docId), [parent.fileHash, child.fileHash]);
  const down = a.documents.getLineage(parent.fileHash);
  assert.deepEqual(down.descendants.map(x => x.docId), [child.fileHash, grandchild.fileHash]);
  await assert.rejects(register(a, 'bad link', { linkedToDocument: 'a'.repeat(64), relationshipType: 'amends' }), /parent document does not exist/);
});

test('stored files are encrypted at rest and decrypt to the original bytes', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const { a } = net.nodes;
  const content = 'Confidential: grades of Juan Dela Cruz';
  const { fileHash } = await register(a, content);
  const raw = fs.readFileSync(a.documents.filePathFor(fileHash));
  assert.equal(raw.includes(Buffer.from('Juan')), false);
  const { buffer } = await a.documents.readFile(fileHash);
  assert.equal(buffer.toString(), content);
});
