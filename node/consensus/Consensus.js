// node/consensus/Consensus.js
//
// Byzantine fault tolerant Proof-of-Authority consensus, modelled on QBFT / IBFT 2.0
// (the protocol family used by Hyperledger Besu for permissioned networks).
//
// n authorities from genesis.json, f = floor((n-1)/3), quorum Q = n - f.
// For each height h, in round r (leader = authorities[(h + r) mod n]):
//
//   PROPOSAL     leader -> all   block B, signed; for r > 0 it carries a justification:
//                                Q ROUND-CHANGE messages for r. If any of them reports a
//                                prepared block, B must be the one prepared in the
//                                highest round.
//   PREPARE      all -> all      after accepting the round's first valid proposal
//   COMMIT       all -> all      after Q PREPAREs for (h, r, B); the COMMIT signature is
//                                the "commit seal" stored in the block
//   FINALIZE     local           after Q COMMIT seals for B: B joins the chain with the
//                                seals as its certificate
//   ROUND-CHANGE all -> all      on timeout; reports the node's highest prepared block and
//                                its prepare certificate. f + 1 round-change messages for a
//                                higher round pull lagging nodes forward.
//
// Safety: no two different blocks are finalized at the same height while at most f
// authorities are Byzantine (any two quorums share an honest node; a committed block
// is prepared by a quorum, so every later justification must carry it forward).
// Liveness: with at most f authorities crashed or offline, once messages are delivered
// within the round timeout. A Byzantine leader can waste its own rounds only; misbehaviour
// (equivocation, conflicting votes, conflicting certificates) is recorded as evidence.
const EventEmitter = require('events');
const Block = require('../blockchain/Block');
const { sign, verify } = require('../crypto/util');

const SYNC_BATCH = 100;
const MAX_ROUND = 1000;

class Consensus extends EventEmitter {
  constructor({ blockchain, p2p, store, log = console, tickMs = 100, syncIntervalMs = 10000 }) {
    super();
    this.bc = blockchain;
    this.p2p = p2p;
    this.store = store;
    this.log = log;
    this.tickMs = tickMs;
    this.syncIntervalMs = syncIntervalMs;
    this.baseTimeoutMs = blockchain.genesis.consensus.roundTimeoutMs;
    this.quorum = blockchain.quorum;
    this.f = blockchain.faultTolerance;

    this.queue = Promise.resolve();
    this.timers = [];
    this.lastSyncRequest = new Map();
    this.metrics = { proposed: 0, committed: 0, roundChanges: 0, rejectedProposals: 0, rejectedVotes: 0, rejectedSyncBlocks: 0, evidence: 0 };
    this.resetHeight();
  }

  // ---------------------------------------------------------------------------
  // Message formats (signed with the authority's Ed25519 key)
  // ---------------------------------------------------------------------------

  msgProposal(h, r, hash) { return `PROPOSAL|${this.bc.chainId}|${h}|${r}|${hash}`; }
  msgPrepare(h, r, hash) { return `PREPARE|${this.bc.chainId}|${h}|${r}|${hash}`; }
  msgCommit(h, hash) { return Block.commitMessage(this.bc.chainId, h, hash); }
  msgRoundChange(h, r, pr, ph) { return `ROUND_CHANGE|${this.bc.chainId}|${h}|${r}|${pr}|${ph || ''}`; }

  sign(message) {
    return sign(this.bc.privateKey, message);
  }

  verifyFrom(nodeId, message, signature) {
    const key = this.bc.authorityKeyOf(nodeId);
    return !!key && verify(key, message, signature);
  }

  // ---------------------------------------------------------------------------
  // Per-height state
  // ---------------------------------------------------------------------------

  resetHeight() {
    this.h = this.bc.height;
    this.round = 0;
    this.active = false;              // round timer running (there is work at this height)
    this.roundStart = Date.now();
    this.blocks = new Map();          // hash -> Block
    this.accepted = new Map();        // round -> hash (proposal this node accepted)
    this.proposalMsgs = new Map();    // round -> proposal message (for re-broadcast)
    this.prepares = new Map();        // `${r}|${hash}` -> Map(nodeId -> sig)
    this.commits = new Map();         // hash -> Map(nodeId -> sig)
    this.voteIndex = new Map();       // `${kind}|${r}|${nodeId}` -> hash (equivocation)
    this.roundChanges = new Map();    // round -> Map(nodeId -> msg)
    this.prepared = null;             // { round, hash, cert: [{nodeId, signature}] }
    this.sentCommitRounds = new Set();
    this.sentRoundChange = new Set();
    this.proposedRounds = new Set();
    this.myMessages = [];             // [type, data] to re-send for healing
    this.finalizing = false;
  }

  async persist() {
    await this.store.setLock(this.h, {
      round: this.round,
      accepted: Object.fromEntries(this.accepted),
      prepared: this.prepared ? { ...this.prepared, block: this.blocks.get(this.prepared.hash).toJSON() } : null
    });
  }

  async restore() {
    const saved = await this.store.getLock(this.h);
    if (!saved || typeof saved !== 'object') return;
    this.round = saved.round || 0;
    this.accepted = new Map(Object.entries(saved.accepted || {}).map(([r, hash]) => [Number(r), hash]));
    if (saved.prepared && saved.prepared.block) {
      const block = Block.fromJSON(saved.prepared.block);
      this.blocks.set(block.hash, block);
      this.prepared = { round: saved.prepared.round, hash: saved.prepared.hash, cert: saved.prepared.cert };
    }
    if (this.round > 0 || this.prepared) {
      this.active = true;
      this.roundStart = Date.now();
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    await this.restore();
    this.p2p.on('message', msg => this.enqueue(() => this.onMessage(msg)));
    this.p2p.on('peer:connected', nodeId => this.enqueue(() => this.onPeerConnected(nodeId)));
    this.timers.push(setInterval(() => this.enqueueTick(), this.tickMs));
    this.timers.push(setInterval(() => this.requestSync(), this.syncIntervalMs));
  }

  stop() {
    this.timers.forEach(t => clearInterval(t));
    this.timers = [];
  }

  enqueue(fn) {
    this.queue = this.queue.then(fn).catch(err => this.log.error && this.log.error('Consensus error:', err));
    return this.queue;
  }

  /** Avoid piling up ticks when the node is busy. */
  enqueueTick() {
    if (this.tickQueued) return;
    this.tickQueued = true;
    this.enqueue(async () => {
      this.tickQueued = false;
      await this.tick();
    });
  }

  timeoutFor(round) {
    return this.baseTimeoutMs * Math.min(2 ** round, 8);
  }

  leader(round = this.round) {
    return this.bc.leaderFor(this.h, round);
  }

  isLeader(round = this.round) {
    return this.bc.isAuthority && this.leader(round) === this.bc.nodeId;
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  submitTransaction(tx) {
    return this.enqueue(() => {
      const result = this.bc.addPendingTransaction(tx);
      if (result.added) this.p2p.broadcast('TX', { tx });
      return result;
    });
  }

  onTx(tx, from) {
    const result = this.bc.addPendingTransaction(tx);
    if (result.added) this.p2p.broadcast('TX', { tx }, { except: from });
  }

  // ---------------------------------------------------------------------------
  // Timer and proposing
  // ---------------------------------------------------------------------------

  async tick() {
    if (!this.bc.isAuthority) return;
    if (!this.active) {
      if (this.bc.pending.size === 0) return;
      this.active = true;
      this.roundStart = Date.now();
    }
    if (Date.now() - this.roundStart > this.timeoutFor(this.round)) {
      await this.moveToRound(this.round + 1);
      return;
    }
    await this.maybePropose();
  }

  async moveToRound(round) {
    if (round <= this.round && this.sentRoundChange.has(round)) return;
    if (round > MAX_ROUND) return;
    if (round > this.round) this.metrics.roundChanges += round - this.round;
    this.round = Math.max(this.round, round);
    this.roundStart = Date.now();
    this.active = true;
    await this.persist();
    if (!this.sentRoundChange.has(this.round)) {
      this.sentRoundChange.add(this.round);
      const pr = this.prepared ? this.prepared.round : -1;
      const ph = this.prepared ? this.prepared.hash : null;
      const msg = {
        h: this.h, r: this.round, nodeId: this.bc.nodeId,
        preparedRound: pr, preparedHash: ph,
        preparedBlock: this.prepared ? this.blocks.get(ph).toJSON() : null,
        prepareCert: this.prepared ? this.prepared.cert : null,
        signature: this.sign(this.msgRoundChange(this.h, this.round, pr, ph))
      };
      this.storeRoundChange(msg);
      this.send('ROUND_CHANGE', msg);
    }
    await this.maybePropose();
  }

  async maybePropose() {
    if (!this.isLeader() || this.proposedRounds.has(this.round)) return;
    const r = this.round;
    let block = null;
    let justification = null;

    if (r === 0) {
      const txs = this.bc.selectTransactionsForBlock();
      if (txs.length === 0) return;
      block = this.bc.createProposal(txs, 0);
    } else {
      const rcs = this.roundChanges.get(r);
      if (!rcs || rcs.size < this.quorum) return;
      justification = Array.from(rcs.values()).slice(0, this.quorum);
      const best = this.highestPrepared(justification);
      if (best) {
        block = this.blocks.get(best.preparedHash);
      } else {
        const txs = this.bc.selectTransactionsForBlock();
        if (txs.length === 0) return;
        block = this.bc.createProposal(txs, r);
      }
      if (!block) return;
    }

    this.proposedRounds.add(r);
    this.metrics.proposed++;
    const msg = {
      h: this.h, r, block: block.toJSON(), justification,
      signature: this.sign(this.msgProposal(this.h, r, block.hash))
    };
    this.log.info && this.log.info(`Proposing block #${this.h} round ${r} (${block.transactions.length} tx)`);
    this.send('PROPOSAL', msg);
    await this.onProposal(msg, this.bc.nodeId);
  }

  highestPrepared(roundChanges) {
    let best = null;
    for (const rc of roundChanges) {
      if (rc.preparedRound >= 0 && (!best || rc.preparedRound > best.preparedRound)) best = rc;
    }
    return best;
  }

  /** Broadcast and remember for re-sending to peers that (re)connect. */
  send(type, data) {
    this.myMessages.push([type, data]);
    this.p2p.broadcast(type, data);
  }

  trigger() {
    return this.enqueue(() => this.tick());
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async onMessage({ type, data, from }) {
    if (!data) return undefined;
    switch (type) {
      case 'TX': return data.tx && this.onTx(data.tx, from);
      case 'PROPOSAL': return this.onProposal(data, from);
      case 'PREPARE': return this.onPrepare(data, from);
      case 'COMMIT': return this.onCommit(data, from);
      case 'ROUND_CHANGE': return this.onRoundChange(data, from);
      case 'COMMITTED': return data.block && this.onCommitted(data.block, from);
      case 'GET_BLOCKS': return this.onGetBlocks(data, from);
      case 'BLOCKS': return Array.isArray(data.blocks) && this.onBlocks(data.blocks, from);
      default: return undefined;
    }
  }

  async onPeerConnected(nodeId) {
    this.p2p.sendTo(nodeId, 'GET_BLOCKS', { fromIndex: this.bc.height });
    for (const tx of this.bc.pending.values()) this.p2p.sendTo(nodeId, 'TX', { tx });
    for (const [type, data] of this.myMessages) this.p2p.sendTo(nodeId, type, data);
  }

  heightCheck(h, from) {
    if (typeof h !== 'number') return false;
    if (h > this.h) {
      this.requestSync(from);
      return false;
    }
    return h === this.h;
  }

  rejectProposal(reason, msg) {
    this.metrics.rejectedProposals++;
    this.log.warn && this.log.warn(`Rejected proposal #${msg.h} round ${msg.r}: ${reason}`);
  }

  /** Validates a round-change message, including its prepared certificate. Returns error or null. */
  checkRoundChange(rc) {
    if (!rc || rc.h !== this.h || !Number.isInteger(rc.r) || rc.r < 1) return 'malformed';
    if (!this.verifyFrom(rc.nodeId, this.msgRoundChange(rc.h, rc.r, rc.preparedRound, rc.preparedHash), rc.signature)) return 'bad signature';
    if (rc.preparedRound >= 0) {
      if (rc.preparedRound >= rc.r) return 'prepared round not below target round';
      if (!rc.preparedBlock || rc.preparedBlock.hash !== rc.preparedHash) return 'missing prepared block';
      const error = this.checkPrepareCert(rc.preparedRound, rc.preparedHash, rc.prepareCert);
      if (error) return error;
    }
    return null;
  }

  checkPrepareCert(round, hash, cert) {
    if (!Array.isArray(cert)) return 'missing prepare certificate';
    const signers = new Set();
    for (const p of cert) {
      if (signers.has(p.nodeId)) continue;
      if (!this.verifyFrom(p.nodeId, this.msgPrepare(this.h, round, hash), p.signature)) return `bad prepare signature from ${p.nodeId}`;
      signers.add(p.nodeId);
    }
    return signers.size >= this.quorum ? null : 'prepare certificate below quorum';
  }

  async onProposal(msg, from) {
    if (!this.heightCheck(msg.h, from)) return;
    const r = msg.r;
    if (!Number.isInteger(r) || r < 0 || r > MAX_ROUND || !msg.block) return;
    const leader = this.leader(r);
    if (!this.verifyFrom(leader, this.msgProposal(msg.h, r, msg.block.hash), msg.signature)) {
      return this.rejectProposal(`not signed by round leader ${leader}`, msg);
    }
    if (r < this.round) return; // stale round

    const block = Block.fromJSON(msg.block);
    const seen = this.proposalMsgs.get(r);
    if (seen) {
      if (seen.block.hash !== block.hash) {
        await this.recordEvidence({ kind: 'proposer-equivocation', height: msg.h, round: r, nodeId: leader, blocks: [seen.block.hash, block.hash] });
      }
      return;
    }

    const error = this.bc.validateProposal(block);
    if (error) return this.rejectProposal(error, msg);

    if (r > 0) {
      const just = Array.isArray(msg.justification) ? msg.justification : [];
      const valid = new Map();
      for (const rc of just) {
        if (rc && rc.r === r && !valid.has(rc.nodeId) && this.checkRoundChange(rc) === null) valid.set(rc.nodeId, rc);
      }
      if (valid.size < this.quorum) return this.rejectProposal('insufficient round-change justification', msg);
      const best = this.highestPrepared(Array.from(valid.values()));
      if (best && best.preparedHash !== block.hash) return this.rejectProposal('does not re-propose the highest prepared block', msg);
    }

    this.proposalMsgs.set(r, msg);
    this.blocks.set(block.hash, block);
    if (from !== this.bc.nodeId) this.p2p.broadcast('PROPOSAL', msg, { except: from }); // relay once

    if (r > this.round) {
      // A justified proposal for a later round: catch up to it.
      this.round = r;
      this.roundStart = Date.now();
    }
    this.active = true;

    if (this.bc.isAuthority && !this.accepted.has(r)) {
      this.accepted.set(r, block.hash);
      await this.persist();
      const prepare = { h: this.h, r, hash: block.hash, nodeId: this.bc.nodeId, signature: this.sign(this.msgPrepare(this.h, r, block.hash)) };
      this.addPrepare(prepare);
      this.send('PREPARE', prepare);
    }
    await this.checkPrepared(r, block.hash);
  }

  addPrepare(p) {
    const key = `${p.r}|${p.hash}`;
    if (!this.prepares.has(key)) this.prepares.set(key, new Map());
    this.prepares.get(key).set(p.nodeId, p.signature);
  }

  async checkVoteEquivocation(kind, round, nodeId, hash, h) {
    const key = `${kind}|${round}|${nodeId}`;
    const prev = this.voteIndex.get(key);
    if (prev && prev !== hash) {
      await this.recordEvidence({ kind: `${kind}-equivocation`, height: h, round, nodeId, blocks: [prev, hash] });
      return true;
    }
    if (!prev) this.voteIndex.set(key, hash);
    return false;
  }

  async onPrepare(p, from) {
    if (!this.heightCheck(p.h, from) || !Number.isInteger(p.r) || typeof p.hash !== 'string') return;
    const set = this.prepares.get(`${p.r}|${p.hash}`);
    if (set && set.has(p.nodeId)) return;
    if (!this.verifyFrom(p.nodeId, this.msgPrepare(p.h, p.r, p.hash), p.signature)) {
      this.metrics.rejectedVotes++;
      this.log.warn && this.log.warn(`Rejected PREPARE claiming to be from ${p.nodeId} (via ${from})`);
      return;
    }
    if (await this.checkVoteEquivocation('prepare', p.r, p.nodeId, p.hash, p.h)) return;
    this.addPrepare(p);
    this.p2p.broadcast('PREPARE', p, { except: from });
    await this.checkPrepared(p.r, p.hash);
  }

  async checkPrepared(r, hash) {
    if (r !== this.round || this.accepted.get(r) !== hash || this.sentCommitRounds.has(r)) return;
    const set = this.prepares.get(`${r}|${hash}`);
    if (!set || set.size < this.quorum) return;

    this.prepared = { round: r, hash, cert: Array.from(set.entries()).map(([nodeId, signature]) => ({ nodeId, signature })) };
    this.sentCommitRounds.add(r);
    await this.persist();
    const commit = { h: this.h, r, hash, nodeId: this.bc.nodeId, signature: this.sign(this.msgCommit(this.h, hash)) };
    this.addCommit(commit);
    this.send('COMMIT', commit);
    await this.checkCommitted(hash);
  }

  addCommit(c) {
    if (!this.commits.has(c.hash)) this.commits.set(c.hash, new Map());
    this.commits.get(c.hash).set(c.nodeId, c.signature);
  }

  async onCommit(c, from) {
    if (!this.heightCheck(c.h, from) || typeof c.hash !== 'string') return;
    const set = this.commits.get(c.hash);
    if (set && set.has(c.nodeId)) return;
    if (!this.verifyFrom(c.nodeId, this.msgCommit(c.h, c.hash), c.signature)) {
      this.metrics.rejectedVotes++;
      this.log.warn && this.log.warn(`Rejected COMMIT claiming to be from ${c.nodeId} (via ${from})`);
      return;
    }
    await this.checkVoteEquivocation('commit', c.r, c.nodeId, c.hash, c.h);
    this.addCommit(c);
    this.p2p.broadcast('COMMIT', c, { except: from });
    await this.checkCommitted(c.hash);
  }

  async checkCommitted(hash) {
    if (this.finalizing) return;
    const block = this.blocks.get(hash);
    const seals = this.commits.get(hash);
    if (!block || !seals || seals.size < this.quorum) return;

    this.finalizing = true;
    try {
      block.commits = Array.from(seals.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([nodeId, signature]) => ({ nodeId, signature }));
      const result = await this.bc.appendCommittedBlock(block);
      if (!result.success) {
        this.log.warn && this.log.warn(`Could not finalize block #${block.index}: ${result.reason}`);
        return;
      }
      this.metrics.committed++;
      this.log.info && this.log.info(`Finalized block #${block.index} in round ${this.round} (${block.transactions.length} tx, ${block.commits.length} seals)`);
      this.p2p.broadcast('COMMITTED', { block: block.toJSON() });
      this.afterCommit();
    } finally {
      this.finalizing = false;
    }
  }

  async onRoundChange(rc, from) {
    if (!this.heightCheck(rc.h, from)) return;
    const existing = this.roundChanges.get(rc.r);
    if (existing && existing.has(rc.nodeId)) return;
    const error = this.checkRoundChange(rc);
    if (error) {
      this.metrics.rejectedVotes++;
      this.log.warn && this.log.warn(`Rejected ROUND_CHANGE from ${rc.nodeId}: ${error}`);
      return;
    }
    if (rc.preparedBlock) {
      const block = Block.fromJSON(rc.preparedBlock);
      if (!this.bc.validateProposal(block)) this.blocks.set(block.hash, block);
    }
    this.storeRoundChange(rc);
    this.p2p.broadcast('ROUND_CHANGE', rc, { except: from });

    // f + 1 nodes want a higher round: at least one honest node timed out, so follow.
    const ahead = new Map();
    for (const [round, msgs] of this.roundChanges) {
      if (round <= this.round) continue;
      for (const nodeId of msgs.keys()) ahead.set(nodeId, Math.min(ahead.get(nodeId) ?? Infinity, round));
    }
    if (ahead.size >= this.f + 1) {
      const target = Math.min(...ahead.values());
      if (target > this.round) await this.moveToRound(target);
    }
    if (rc.r === this.round) await this.maybePropose();
  }

  storeRoundChange(rc) {
    if (!this.roundChanges.has(rc.r)) this.roundChanges.set(rc.r, new Map());
    this.roundChanges.get(rc.r).set(rc.nodeId, rc);
  }

  afterCommit() {
    this.resetHeight();
    this.emit('committed', this.bc.getLatestBlock());
  }

  async onCommitted(json, from) {
    const block = Block.fromJSON(json);
    if (block.index < this.bc.height) return this.checkFork(block, from);
    if (block.index > this.bc.height) return this.requestSync(from);
    const result = await this.bc.appendCommittedBlock(block);
    if (result.success) {
      this.afterCommit();
    } else {
      this.metrics.rejectedSyncBlocks++;
      this.log.warn && this.log.warn(`Rejected committed block #${block.index} from ${from}: ${result.reason}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync: blocks are fully re-validated (including certificates) and only appended.
  // ---------------------------------------------------------------------------

  requestSync(nodeId) {
    const key = nodeId || '*';
    const now = Date.now();
    if (now - (this.lastSyncRequest.get(key) || 0) < 1000) return;
    this.lastSyncRequest.set(key, now);
    if (nodeId) this.p2p.sendTo(nodeId, 'GET_BLOCKS', { fromIndex: this.bc.height });
    else this.p2p.broadcast('GET_BLOCKS', { fromIndex: this.bc.height });
  }

  onGetBlocks({ fromIndex }, from) {
    const start = Math.max(0, Number(fromIndex) || 0);
    if (start >= this.bc.height) return;
    this.p2p.sendTo(from, 'BLOCKS', { blocks: this.bc.chain.slice(start, start + SYNC_BATCH).map(b => b.toJSON()) });
  }

  async onBlocks(list, from) {
    let appended = 0;
    for (const json of list) {
      const block = Block.fromJSON(json);
      if (block.index < this.bc.height) {
        await this.checkFork(block, from);
        continue;
      }
      if (block.index > this.bc.height) break;
      const result = await this.bc.appendCommittedBlock(block, { checkDrift: false });
      if (!result.success) {
        this.metrics.rejectedSyncBlocks++;
        this.log.warn && this.log.warn(`Sync from ${from} rejected block #${block.index}: ${result.reason}`);
        break;
      }
      appended++;
      this.afterCommit();
    }
    if (appended > 0) {
      this.log.info && this.log.info(`Synced ${appended} block(s) from ${from}, height now ${this.bc.height}`);
      if (list.length === SYNC_BATCH) this.requestSync(from);
    }
  }

  async checkFork(block, from) {
    const ours = this.bc.chain[block.index];
    if (!ours || ours.hash === block.hash || block.index === 0) return;
    if (this.bc.verifyCertificate(block) === null) {
      this.log.error && this.log.error(`SAFETY ALERT: conflicting certified block at height ${block.index} from ${from}`);
      await this.recordEvidence({ kind: 'conflicting-certificate', height: block.index, from, ours: ours.hash, theirs: block.hash, commits: block.commits });
    }
  }

  async recordEvidence(item) {
    this.metrics.evidence++;
    this.log.warn && this.log.warn(`Evidence recorded: ${item.kind} at height ${item.height} (${item.nodeId || item.from || ''})`);
    await this.store.addEvidence({ ...item, detectedBy: this.bc.nodeId, detectedAt: new Date().toISOString() });
    this.emit('evidence', item);
  }

  // Compatibility with the status API
  get height() { return this.h; }
  get lastRound() { return this.round; }

  getStatus() {
    return {
      protocol: 'QBFT-style PoA',
      height: this.h,
      round: this.round,
      leader: this.leader(),
      prepared: this.prepared ? { round: this.prepared.round, hash: this.prepared.hash } : null,
      proposals: this.proposalMsgs.size,
      quorum: this.quorum,
      faultTolerance: this.f,
      roundTimeoutMs: this.baseTimeoutMs,
      metrics: { ...this.metrics }
    };
  }
}

module.exports = Consensus;
