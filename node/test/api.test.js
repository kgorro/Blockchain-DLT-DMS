// HTTP API tests (no MongoDB needed: in-memory ledger storage, stubbed user lookup).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-'.repeat(4);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const User = require('../models/User');
const { generateToken } = require('../middleware/auth');
const { createApp } = require('../app');
const DocumentNLPProcessor = require('../nlp/DocumentNLPProcessor');
const { loadNetworkConfig } = require('../network/config');
const { startNetwork, waitFor } = require('./helpers');

const USERS = {
  admin1: { _id: 'admin1', username: 'registrar', email: 'r@ctu.example', role: 'admin', isActive: true }
};
User.findById = async id => USERS[id] || null;

async function startApi(t) {
  const net = await startNetwork({ authorities: ['node-1', 'node-2', 'node-3', 'node-4'], roundTimeout: 500 });
  const node = net.nodes['node-1'];
  const nlp = node.documents.nlp;
  const app = createApp({
    blockchain: node.bc, p2pServer: node.p2p, consensus: node.consensus, documents: node.documents,
    network: loadNetworkConfig({ nodeId: 'node-1', dir: net.dir }), nlpProcessor: nlp,
    nodeId: 'node-1', httpPort: 0, p2pPort: node.p2p.port, tempDir: fs.mkdtempSync(path.join(os.tmpdir(), 'api-'))
  });
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(async () => {
    server.close();
    await net.stop();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { net, node, base };
}

const adminHeaders = () => ({ Authorization: `Bearer ${generateToken('admin1')}` });

function uploadForm(content, fields = {}) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), 'tor-juan.txt');
  const all = { title: 'TOR - Juan Dela Cruz', category: 'academic', documentType: 'Transcript', recipient: 'Juan Dela Cruz', enableNLP: 'false', ...fields };
  for (const [k, v] of Object.entries(all)) form.append(k, v);
  return form;
}

test('end-to-end: upload, finalize, guest vs admin views, verify, download, erase', async t => {
  const { base, node } = await startApi(t);
  const content = 'Official transcript for Juan Dela Cruz';

  // Upload requires an admin
  let res = await fetch(`${base}/api/documents/upload`, { method: 'POST', body: uploadForm(content) });
  assert.equal(res.status, 401);

  res = await fetch(`${base}/api/documents/upload`, { method: 'POST', headers: adminHeaders(), body: uploadForm(content) });
  assert.equal(res.status, 201, await res.clone().text());
  const { fileHash } = await res.json();
  assert.ok(await waitFor(() => node.bc.getDocumentEntry(fileHash)), 'finalized');

  // Duplicate registration refused
  res = await fetch(`${base}/api/documents/upload`, { method: 'POST', headers: adminHeaders(), body: uploadForm(content) });
  assert.equal(res.status, 409);

  // Guests see the ledger view only
  let list = await (await fetch(`${base}/api/documents`)).json();
  assert.equal(list.documents[0].title, '[Restricted]');
  assert.equal(JSON.stringify(list).includes('Juan'), false);
  // Admins see decrypted metadata
  list = await (await fetch(`${base}/api/documents`, { headers: adminHeaders() })).json();
  assert.equal(list.documents[0].recipient, 'Juan Dela Cruz');
  assert.equal(list.documents[0].metadataStatus, 'verified');

  // Public verification
  const vform = new FormData();
  vform.append('file', new Blob([content]), 'any-name.txt');
  const verified = await (await fetch(`${base}/api/documents/verify`, { method: 'POST', body: vform })).json();
  assert.equal(verified.isValid, true);
  assert.equal(verified.certificateValid, true);
  assert.equal(verified.merkleProofValid, true);
  assert.ok(verified.finalizedBy.length >= 3);
  assert.equal(JSON.stringify(verified).includes('Juan'), false, 'no personal data to anonymous verifiers');

  const altered = new FormData();
  altered.append('file', new Blob([content + ' (edited)']), 'x.txt');
  assert.equal((await (await fetch(`${base}/api/documents/verify`, { method: 'POST', body: altered })).json()).isValid, false);

  // File access
  assert.equal((await fetch(`${base}/api/documents/${fileHash}/file`)).status, 401);
  const file = await fetch(`${base}/api/documents/${fileHash}/file`, { headers: adminHeaders() });
  assert.equal(await file.text(), content);
  assert.equal((await fetch(`${base}/uploads/anything`)).status, 404, 'no static uploads directory');

  // Proof and lineage are public and contain no personal data
  const proof = await (await fetch(`${base}/api/documents/${fileHash}/proof`)).json();
  assert.equal(proof.proof.txId, node.bc.getDocumentEntry(fileHash).tx.id);
  assert.equal(JSON.stringify(proof).includes('Juan'), false);

  // Guest search returns nothing; admin search finds it
  const guestSearch = await (await fetch(`${base}/api/documents/search?q=Juan`)).json();
  assert.equal(guestSearch.count, 0);
  const adminSearch = await (await fetch(`${base}/api/documents/search?q=Juan`, { headers: adminHeaders() })).json();
  assert.equal(adminSearch.count, 1);

  // Erasure
  res = await fetch(`${base}/api/documents/${fileHash}/erase`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...adminHeaders() }, body: JSON.stringify({ reasonCode: 'data_subject_request' })
  });
  assert.equal(res.status, 202);
  assert.ok(await waitFor(() => node.bc.getErasure(fileHash)));
  const after = await (await fetch(`${base}/api/documents/${fileHash}`, { headers: adminHeaders() })).json();
  assert.equal(after.document.metadataStatus, 'erased');
  assert.equal((await fetch(`${base}/api/documents/${fileHash}/file`, { headers: adminHeaders() })).status, 410);
  const reverify = await (await fetch(`${base}/api/documents/verify`, { method: 'POST', body: vform })).json();
  assert.equal(reverify.isValid, true, 'authenticity still provable after erasure');

  const chain = await (await fetch(`${base}/api/blockchain/verify`)).json();
  assert.equal(chain.valid, true);
});

test('administrative endpoints require an admin token', async t => {
  const { base } = await startApi(t);
  for (const [method, url] of [
    ['POST', '/api/mine'],
    ['POST', '/api/network/peers'],
    ['POST', '/api/network/sync'],
    ['GET', '/api/consensus/evidence'],
    ['POST', `/api/documents/${'a'.repeat(64)}/erase`]
  ]) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 401, `${method} ${url}`);
  }
  const forged = await fetch(`${base}/api/mine`, { method: 'POST', headers: { Authorization: 'Bearer forged.token.value' } });
  assert.equal(forged.status, 401);
});

test('upload rejects unknown relationship types and links to missing parents', async t => {
  const { base } = await startApi(t);
  const res = await fetch(`${base}/api/documents/upload`, {
    method: 'POST', headers: adminHeaders(),
    body: uploadForm('child doc', { linkedToDocument: 'b'.repeat(64), relationshipType: 'amends' })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /parent document does not exist/);
});
