// Integration tests: real P2P networking and consensus between in-process nodes,
// including crash faults and Byzantine (malicious authority / outsider) behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startNetwork, startNode, connect, waitFor, documentTx, sleep } = require('./helpers');
const P2PServer = require('../p2p/P2PServer');
const Block = require('../blockchain/Block');
const { generateKeyPair, sign } = require('../crypto/util');

const tips = nodes => new Set(nodes.map(n => n.bc.getLatestBlock().hash));

test('four authorities finalize documents and hold identical, verifiable chains', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const nodes = Object.values(net.nodes);
  const txs = nodes.map(n => documentTx(n));
  for (let i = 0; i < txs.length; i++) await nodes[i].consensus.submitTransaction(txs[i]);

  assert.ok(await waitFor(() => nodes.every(n => n.bc.state.documents.size === 4)), 'all documents finalized everywhere');
  assert.equal(tips(nodes).size, 1, 'same tip on every node');
  for (const n of nodes) assert.equal((await n.bc.verifyChain()).valid, true);
  const last = nodes[0].bc.getLatestBlock();
  assert.ok(last.commits.length >= 3, 'block carries a quorum certificate');
});

test('liveness with one authority offline (f = 1), including the scheduled leader', async t => {
  const net = await startNetwork({ roundTimeout: 400 });
  t.after(() => net.stop());
  const { a } = net.nodes;
  const leader = net.nodes[a.bc.leaderFor(a.bc.height, 0)];
  await leader.stop();
  const live = Object.values(net.nodes).filter(n => n !== leader);

  const tx = documentTx(live[0]);
  await live[0].consensus.submitTransaction(tx);
  assert.ok(await waitFor(() => live.every(n => n.bc.state.documents.has(tx.data.docId))), 'committed without the leader');
  assert.ok(live.some(n => n.consensus.metrics.roundChanges > 0), 'a round change happened');
  assert.equal(tips(live).size, 1);
});

test('safety over liveness: with two of four authorities offline nothing is finalized', async t => {
  const net = await startNetwork({ roundTimeout: 300 });
  t.after(() => net.stop());
  await net.nodes.c.stop();
  await net.nodes.d.stop();
  const { a, b } = net.nodes;
  const tx = documentTx(a);
  await a.consensus.submitTransaction(tx);
  await sleep(2000);
  assert.equal(a.bc.height, 1, 'no block without a quorum');
  assert.equal(b.bc.height, 1);
  assert.ok(a.bc.pending.has(tx.id), 'transaction waits in the pending pool');
});

test('an offline node catches up by sync and re-verifies every block', async t => {
  const net = await startNetwork({ roundTimeout: 400 });
  t.after(() => net.stop());
  const { a, b, c, d } = net.nodes;
  await d.stop();
  for (let i = 0; i < 3; i++) {
    const tx = documentTx(a);
    await a.consensus.submitTransaction(tx);
    assert.ok(await waitFor(() => [a, b, c].every(n => n.bc.state.documents.has(tx.data.docId))));
  }

  // Restart d with its existing (stale) storage
  const d2 = await startNode(net.dir, 'd', { store: d.store });
  net.nodes.d = d2;
  connect(d2, a);
  assert.ok(await waitFor(() => d2.bc.height === a.bc.height), 'd synced');
  assert.equal(d2.bc.getLatestBlock().hash, a.bc.getLatestBlock().hash);
  assert.equal((await d2.bc.verifyChain()).valid, true);
});

test('a node key not in genesis.json cannot join, even claiming a member id', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const { a } = net.nodes;
  const rejected = [];
  a.p2p.on('peer:rejected', reason => rejected.push(reason));

  const impostor = generateKeyPair();
  const members = [...a.cfg.genesis.members.filter(m => m.nodeId !== 'b'), { nodeId: 'b', role: 'authority', publicKey: impostor.publicKey }];
  const fake = new P2PServer({
    nodeId: 'b', port: 0, privateKey: impostor.privateKey, members,
    chainId: a.cfg.genesis.chainId, genesisHash: a.cfg.genesisHash, log: { info() {}, warn() {} }
  });
  await fake.listen();
  t.after(() => fake.close());
  fake.connectToPeer(`ws://127.0.0.1:${a.p2p.port}`);

  assert.ok(await waitFor(() => rejected.some(r => /Invalid envelope signature/.test(r))), 'impostor rejected');
  assert.equal(a.p2p.peers.size, 3, 'peer set unchanged');
});

test('a recorded HELLO cannot be replayed to hijack a peer slot', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const { a, b } = net.nodes;
  // Capture a genuine signed HELLO from b
  const hello = b.p2p.envelope('HELLO', { chainId: b.p2p.chainId, genesisHash: b.p2p.genesisHash, challenge: 'f'.repeat(32) });
  const rejected = [];
  a.p2p.on('peer:rejected', r => rejected.push(r));

  const ws = new WebSocket(`ws://127.0.0.1:${a.p2p.port}`);
  t.after(() => ws.terminate());
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify(hello));
  // The attacker cannot sign a's fresh challenge with b's key; reuse any b-signed AUTH it may have seen
  const staleAuth = b.p2p.envelope('AUTH', { challenge: '0'.repeat(32) });
  ws.send(JSON.stringify(staleAuth));
  assert.ok(await waitFor(() => rejected.some(r => /does not answer our challenge/.test(r))));
});

test('forged votes from a Byzantine authority are rejected', async t => {
  const net = await startNetwork();
  t.after(() => net.stop());
  const { a, d } = net.nodes;
  const h = a.bc.height;
  const hash = 'f'.repeat(64);
  // d signs votes but labels them as coming from a
  d.p2p.broadcast('COMMIT', { h, r: 0, hash, nodeId: 'a', signature: sign(d.cfg.privateKey, Block.commitMessage(a.bc.chainId, h, hash)) });
  d.p2p.broadcast('PREPARE', { h, r: 0, hash, nodeId: 'a', signature: sign(d.cfg.privateKey, `PREPARE|${a.bc.chainId}|${h}|0|${hash}`) });
  assert.ok(await waitFor(() => net.nodes.b.consensus.metrics.rejectedVotes > 0));
});

test('a Byzantine authority cannot rewrite history through sync', async t => {
  const net = await startNetwork({ roundTimeout: 400 });
  t.after(() => net.stop());
  const { a, b, c, d } = net.nodes;
  const tx = documentTx(a);
  await a.consensus.submitTransaction(tx);
  assert.ok(await waitFor(() => [a, b, c, d].every(n => n.bc.height === 2)));
  const before = b.bc.getLatestBlock().hash;

  // d builds an alternative history: a different block 1 plus extra blocks, each signed
  // only by d (it cannot obtain a quorum of signatures), then serves it as "longer".
  const fakeChain = [];
  let prev = d.bc.chain[0];
  for (let i = 1; i <= 5; i++) {
    const blk = new Block({
      chainId: d.bc.chainId, index: i, timestamp: prev.timestamp + 1, previousHash: prev.hash,
      transactions: [documentTx(d)], proposer: d.bc.leaderFor(i, 0), round: 0
    });
    blk.signAsProposer(d.cfg.privateKey);
    blk.commits = [{ nodeId: 'd', signature: d.bc.signCommit(blk) }];
    fakeChain.push(blk.toJSON());
    prev = blk;
  }
  d.p2p.sendTo('b', 'BLOCKS', { blocks: fakeChain });
  d.p2p.sendTo('b', 'COMMITTED', { block: fakeChain[4] });
  await sleep(500);
  assert.equal(b.bc.height, 2, 'chain not replaced or extended');
  assert.equal(b.bc.getLatestBlock().hash, before);
  assert.equal((await b.bc.verifyChain()).valid, true);
});

test('an equivocating leader is detected and recorded as evidence', async t => {
  const net = await startNetwork({ roundTimeout: 3000 });
  t.after(() => net.stop());
  const { a } = net.nodes;
  const leader = net.nodes[a.bc.leaderFor(a.bc.height, 0)];
  // The leader signs two different blocks for the same height and round.
  const h = leader.bc.height;
  const b1 = leader.bc.createProposal([documentTx(leader)], 0);
  const b2 = leader.bc.createProposal([documentTx(leader)], 0);
  const msg = b => ({ h, r: 0, block: b.toJSON(), justification: null, signature: leader.consensus.sign(leader.consensus.msgProposal(h, 0, b.hash)) });
  leader.p2p.broadcast('PROPOSAL', msg(b1));
  leader.p2p.broadcast('PROPOSAL', msg(b2));
  const others = Object.values(net.nodes).filter(n => n !== leader);
  assert.ok(await waitFor(async () => {
    for (const n of others) {
      const ev = await n.store.listEvidence();
      if (ev.some(e => e.kind === 'proposer-equivocation' && e.nodeId === leader.id)) return true;
    }
    return false;
  }), 'equivocation evidence recorded');
  // Safety: whichever block wins, all nodes that finalize agree
  await sleep(500);
  const heights = Object.values(net.nodes).map(n => n.bc.height);
  if (heights.every(h => h === 2)) assert.equal(tips(Object.values(net.nodes)).size, 1);
});

test('nodes on a different network are refused', async t => {
  const net1 = await startNetwork({ authorities: ['a', 'b', 'c', 'd'] });
  const net2 = await startNetwork({ authorities: ['a', 'b', 'c', 'd'] });
  t.after(async () => { await net1.stop(); await net2.stop(); });
  const rejected = [];
  net1.nodes.a.p2p.on('peer:rejected', r => rejected.push(r));
  net2.nodes.b.p2p.connectToPeer(`ws://127.0.0.1:${net1.nodes.a.p2p.port}`);
  assert.ok(await waitFor(() => rejected.length > 0));
  assert.equal(net1.nodes.a.p2p.peers.size, 3);
});

test('stress: random message delays force round changes, chains never fork', async t => {
  const net = await startNetwork({ roundTimeout: 150 });
  t.after(() => net.stop());
  const nodes = Object.values(net.nodes);
  // Delay every outgoing message by 0-250 ms (longer than the round timeout).
  for (const n of nodes) {
    const broadcast = n.p2p.broadcast.bind(n.p2p);
    const sendTo = n.p2p.sendTo.bind(n.p2p);
    n.p2p.broadcast = (...args) => setTimeout(() => broadcast(...args), Math.random() * 250);
    n.p2p.sendTo = (...args) => { setTimeout(() => sendTo(...args), Math.random() * 250); return true; };
  }
  const txs = [];
  for (let i = 0; i < 40; i++) {
    const n = nodes[i % nodes.length];
    const tx = documentTx(n);
    txs.push(tx);
    await n.consensus.submitTransaction(tx);
    if (i % 5 === 0) await sleep(100);
  }
  assert.ok(await waitFor(() => nodes.every(n => txs.every(tx => n.bc.state.documents.has(tx.data.docId))), 60000), 'all finalized despite delays');
  const height = Math.min(...nodes.map(n => n.bc.height));
  for (let i = 0; i < height; i++) {
    assert.equal(new Set(nodes.map(n => n.bc.chain[i].hash)).size, 1, `same block at height ${i}`);
  }
  assert.ok(nodes.some(n => n.consensus.metrics.roundChanges > 0), 'round changes were exercised');
  for (const n of nodes) assert.equal((await n.bc.verifyChain()).valid, true);
});

test('a later-round proposal without round-change justification is rejected', async t => {
  const net = await startNetwork({ roundTimeout: 5000 });
  t.after(() => net.stop());
  const { a } = net.nodes;
  const h = a.bc.height;
  const leader1 = net.nodes[a.bc.leaderFor(h, 1)];
  const block = leader1.bc.createProposal([documentTx(leader1)], 1);
  leader1.p2p.broadcast('PROPOSAL', { h, r: 1, block: block.toJSON(), justification: [], signature: leader1.consensus.sign(leader1.consensus.msgProposal(h, 1, block.hash)) });
  const others = Object.values(net.nodes).filter(n => n !== leader1);
  assert.ok(await waitFor(() => others.every(n => n.consensus.metrics.rejectedProposals > 0)));
  await sleep(300);
  assert.ok(others.every(n => n.bc.height === h), 'nothing finalized');
});

test('a node that finds its own address in the peer list stops dialling it', async t => {
  const net = await startNetwork({ authorities: ['a', 'b', 'c', 'd'] });
  t.after(() => net.stop());
  const { a } = net.nodes;
  const url = `ws://127.0.0.1:${a.p2p.port}`;
  a.p2p.connectToPeer(url);
  assert.ok(await waitFor(() => a.p2p.outbound.get(url) && a.p2p.outbound.get(url).self));
  assert.equal(a.p2p.peers.size, 3);
});
