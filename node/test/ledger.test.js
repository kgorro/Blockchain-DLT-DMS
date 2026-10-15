// Unit tests for ledger validation rules (no networking).
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateNetwork, documentTx } = require('./helpers');
const { loadNetworkConfig } = require('../network/config');
const Blockchain = require('../blockchain/Blockchain');
const Block = require('../blockchain/Block');
const MemoryStore = require('../storage/MemoryStore');
const { createTransaction } = require('../blockchain/Transaction');
const { sign, sha256, verifyMerkleProof, merkleProof, merkleRoot, generateKeyPair } = require('../crypto/util');

async function makeLedgers(ids = ['a', 'b', 'c', 'd'], observers = ['obs']) {
  const dir = generateNetwork({ authorities: ids, observers });
  const nodes = {};
  for (const id of [...ids, ...observers]) {
    const cfg = loadNetworkConfig({ nodeId: id, dir });
    const store = new MemoryStore();
    const bc = new Blockchain({ nodeId: id, genesis: cfg.genesis, genesisHash: cfg.genesisHash, privateKey: cfg.privateKey, store });
    await bc.initialize();
    nodes[id] = { id, cfg, bc, store };
  }
  return { dir, nodes };
}

function copy(block) {
  return Block.fromJSON(JSON.parse(JSON.stringify(block.toJSON())));
}

/** Build a properly proposed and certified block on top of the leader's ledger. */
function certifiedBlock(nodes, txs, signers = ['a', 'b', 'c']) {
  const any = Object.values(nodes)[0].bc;
  const leaderId = any.leaderFor(any.height, 0);
  const leader = nodes[leaderId].bc;
  const block = leader.createProposal(txs, 0);
  block.commits = signers.map(id => ({ nodeId: id, signature: nodes[id].bc.signCommit(block) }));
  return block;
}

test('genesis is deterministic and bound to genesis.json', async () => {
  const { nodes } = await makeLedgers();
  const hashes = new Set(Object.values(nodes).map(n => n.bc.chain[0].hash));
  assert.equal(hashes.size, 1);
  const other = await makeLedgers();
  assert.notEqual(other.nodes.a.bc.chain[0].hash, nodes.a.bc.chain[0].hash, 'a different network definition must give a different genesis');
});

test('quorum is n - f for BFT safety', async () => {
  const { nodes } = await makeLedgers(['a', 'b', 'c', 'd']);
  assert.equal(nodes.a.bc.quorum, 3);
  assert.equal(nodes.a.bc.faultTolerance, 1);
  const seven = await makeLedgers(['a', 'b', 'c', 'd', 'e', 'f', 'g'], []);
  assert.equal(seven.nodes.a.bc.quorum, 5);
  assert.equal(seven.nodes.a.bc.faultTolerance, 2);
});

test('a block with a full certificate is accepted by every node', async () => {
  const { nodes } = await makeLedgers();
  const block = certifiedBlock(nodes, [documentTx(nodes.a)]);
  for (const n of Object.values(nodes)) {
    const r = await n.bc.appendCommittedBlock(copy(block));
    assert.equal(r.success, true, `${n.id}: ${r.reason}`);
    assert.deepEqual(await n.bc.verifyChain(), { valid: true, blockCount: 2 });
  }
});

test('certificate below quorum is rejected', async () => {
  const { nodes } = await makeLedgers();
  const block = certifiedBlock(nodes, [documentTx(nodes.a)], ['a', 'b']);
  const r = await nodes.c.bc.appendCommittedBlock(copy(block));
  assert.equal(r.success, false);
  assert.match(r.reason, /quorum/);
});

test('duplicate signer cannot inflate a certificate', async () => {
  const { nodes } = await makeLedgers();
  const block = certifiedBlock(nodes, [documentTx(nodes.a)], ['a', 'b']);
  block.commits.push({ ...block.commits[0] });
  const r = await nodes.c.bc.appendCommittedBlock(copy(block));
  assert.match(r.reason, /Duplicate signer/);
});

test('observer keys and forged signatures do not count toward the certificate', async () => {
  const { nodes } = await makeLedgers();
  const block = certifiedBlock(nodes, [documentTx(nodes.a)], ['a', 'b']);
  block.commits.push({ nodeId: 'obs', signature: nodes.obs.bc.signCommit(block) });
  let r = await nodes.c.bc.appendCommittedBlock(copy(block));
  assert.match(r.reason, /Invalid commit signature from obs/);

  // Signature made with a's key but labelled as c
  block.commits[2] = { nodeId: 'c', signature: nodes.a.bc.signCommit(block) };
  r = await nodes.d.bc.appendCommittedBlock(copy(block));
  assert.match(r.reason, /Invalid commit signature from c/);
});

test('forged proposer signature is rejected', async () => {
  const { nodes } = await makeLedgers();
  const block = certifiedBlock(nodes, [documentTx(nodes.a)]);
  const forged = copy(block);
  const attackerKey = generateKeyPair().privateKey;
  forged.signature = sign(attackerKey, Block.proposalMessage(forged.hash));
  const r = await nodes.d.bc.appendCommittedBlock(forged);
  assert.match(r.reason, /Invalid proposer signature/);
});

test('a non-leader authority cannot propose out of turn', async () => {
  const { nodes } = await makeLedgers();
  const leaderId = nodes.a.bc.leaderFor(1, 0);
  const other = Object.keys(nodes).find(id => id !== leaderId && id !== 'obs');
  const block = nodes[other].bc.createProposal([documentTx(nodes[other])], 0);
  assert.match(nodes.a.bc.validateProposal(block), /not the leader/);
});

test('tampering with any committed field breaks validation', async () => {
  const { nodes } = await makeLedgers();
  const block = certifiedBlock(nodes, [documentTx(nodes.a)]);

  const changedTx = copy(block);
  changedTx.transactions[0].data.category = 'tampered';
  assert.equal((await nodes.b.bc.appendCommittedBlock(changedTx)).success, false);

  const changedHeader = copy(block);
  changedHeader.timestamp += 1;
  assert.match((await nodes.b.bc.appendCommittedBlock(changedHeader)).reason, /Invalid block hash/);

  const droppedTx = copy(block);
  droppedTx.transactions = [];
  assert.match((await nodes.b.bc.appendCommittedBlock(droppedTx)).reason, /Transaction root mismatch/);
});

test('personal data cannot be written on-chain', async () => {
  const { nodes } = await makeLedgers();
  const tx = documentTx(nodes.a, { data: { title: 'Transcript of Records - Juan Dela Cruz' } });
  const r = nodes.a.bc.addPendingTransaction(tx);
  assert.equal(r.added, false);
  assert.match(r.reason, /Fields not allowed on-chain: title/);
});

test('transactions must be signed by an authority and cannot be altered or replayed', async () => {
  const { nodes } = await makeLedgers();
  const outsider = generateKeyPair();
  const fileHash = sha256('x');
  const fake = createTransaction({
    type: 'document', submitter: 'a', privateKey: outsider.privateKey,
    data: { schema: 1, docId: fileHash, fileHash, category: 'c', documentType: 't', linkedToDocument: null, relationshipType: null, recordCommitment: sha256('r'), originNode: 'a', uploaderRef: sha256('u') }
  });
  assert.match(nodes.b.bc.addPendingTransaction(fake).reason, /Invalid transaction signature/);

  const byObserver = documentTx(nodes.obs);
  assert.match(nodes.b.bc.addPendingTransaction(byObserver).reason, /not an authority/);

  const good = documentTx(nodes.a);
  const altered = JSON.parse(JSON.stringify(good));
  altered.data.documentType = 'Diploma';
  assert.match(nodes.b.bc.addPendingTransaction(altered).reason, /id does not match/);

  const block = certifiedBlock(nodes, [good]);
  assert.equal((await nodes.b.bc.appendCommittedBlock(copy(block))).success, true);
  assert.match(nodes.b.bc.addPendingTransaction(good).reason, /already committed/);
  const again = documentTx(nodes.a, { fileHash: good.data.fileHash });
  assert.match(nodes.b.bc.addPendingTransaction(again).reason, /already registered/);
});

test('lineage links must point to an existing document', async () => {
  const { nodes } = await makeLedgers();
  const orphan = documentTx(nodes.a, { data: { linkedToDocument: sha256('missing'), relationshipType: 'amends' } });
  assert.match(nodes.a.bc.addPendingTransaction(orphan).reason, /parent document does not exist/);
});

test('tampering with the stored ledger is detected at startup', async () => {
  const { nodes } = await makeLedgers();
  const block = certifiedBlock(nodes, [documentTx(nodes.a)]);
  await nodes.b.bc.appendCommittedBlock(copy(block));

  // An administrator edits the database directly
  nodes.b.store.blocks[1].transactions[0].data.documentType = 'Diploma';
  const restarted = new Blockchain({
    nodeId: 'b', genesis: nodes.b.cfg.genesis, genesisHash: nodes.b.cfg.genesisHash,
    privateKey: nodes.b.cfg.privateKey, store: nodes.b.store
  });
  await assert.rejects(restarted.initialize(), err => err.code === 'LEDGER_TAMPERED');
});

test('merkle inclusion proofs verify for every leaf', () => {
  for (const size of [1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: size }, (_, i) => sha256(String(i)));
    const root = merkleRoot(leaves);
    leaves.forEach((leaf, i) => assert.ok(verifyMerkleProof(leaf, merkleProof(leaves, i), root)));
    assert.equal(verifyMerkleProof(sha256('other'), merkleProof(leaves, 0), root), false);
  }
});
