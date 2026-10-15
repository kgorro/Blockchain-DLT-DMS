// node/p2p/P2PServer.js
//
// Authenticated peer-to-peer transport.
//
//  - Every message is an envelope { type, from, ts, data, sig } signed with the
//    sender's Ed25519 key. Receivers verify it against the public key listed for
//    `from` in genesis.json, so a peer cannot impersonate another node.
//  - A connection is accepted only after a signed HELLO that matches this
//    network's chainId and genesis hash, from a node listed in genesis.json,
//    followed by a signed AUTH that answers our random challenge (so a recorded
//    HELLO cannot be replayed to hijack a peer slot).
//  - After HELLO, the socket is bound to that node id; envelopes claiming a
//    different sender on the same socket are dropped and the socket is closed.
//  - Outbound connections reconnect automatically with backoff.
//
// Consensus, sync and record replication subscribe to the 'message' event.
const EventEmitter = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const { canonicalize, sign, verify } = require('../crypto/util');

const HELLO_MAX_SKEW_MS = 2 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

class P2PServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.nodeId
   * @param {number} opts.port
   * @param {string} opts.privateKey
   * @param {Array}  opts.members      genesis members [{ nodeId, role, publicKey }]
   * @param {string} opts.chainId
   * @param {string} opts.genesisHash
   * @param {object} [opts.log]
   */
  constructor({ nodeId, port, privateKey, members, chainId, genesisHash, log = console }) {
    super();
    this.nodeId = nodeId;
    this.port = port;
    this.privateKey = privateKey;
    this.members = new Map(members.map(m => [m.nodeId, m]));
    this.chainId = chainId;
    this.genesisHash = genesisHash;
    this.log = log;

    this.server = null;
    this.sockets = new Set();          // all open sockets
    this.peers = new Map();            // nodeId -> Set<socket> (authenticated)
    this.outbound = new Map();         // url -> { attempts, timer, socket }
    this.closed = false;
    this.heartbeat = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  listen() {
    return new Promise((resolve, reject) => {
      this.server = new WebSocket.Server({ port: this.port, maxPayload: MAX_PAYLOAD_BYTES });
      this.server.on('connection', (socket, req) => {
        this.log.info && this.log.info(`P2P inbound connection from ${req.socket.remoteAddress}`);
        this.setupSocket(socket);
      });
      this.server.on('listening', () => {
        this.port = this.server.address().port;
        this.log.info && this.log.info(`P2P listening on port ${this.port}`);
        resolve(this.port);
      });
      this.server.on('error', reject);
      this.heartbeat = setInterval(() => this.pingAll(), 30000);
    });
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const entry of this.outbound.values()) clearTimeout(entry.timer);
    for (const socket of this.sockets) {
      try { socket.terminate(); } catch (e) { /* ignore */ }
    }
    this.sockets.clear();
    this.peers.clear();
    return new Promise(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  connectToPeer(url) {
    if (this.closed) return;
    if (!/^wss?:\/\//.test(url)) {
      this.log.warn && this.log.warn(`Ignoring invalid peer URL: ${url}`);
      return;
    }
    let entry = this.outbound.get(url);
    if (!entry) {
      entry = { attempts: 0, timer: null, socket: null };
      this.outbound.set(url, entry);
    }
    if (entry.self || (entry.socket && entry.socket.readyState <= WebSocket.OPEN)) return;

    const socket = new WebSocket(url, { maxPayload: MAX_PAYLOAD_BYTES });
    entry.socket = socket;
    socket.on('open', () => {
      entry.attempts = 0;
      this.setupSocket(socket);
    });
    socket.on('error', err => {
      if (entry.attempts === 0) this.log.warn && this.log.warn(`P2P connection to ${url} failed: ${err.message}`);
    });
    socket.on('close', () => {
      if (this.closed || entry.self) return;
      entry.attempts += 1;
      const delay = Math.min(30000, 500 * 2 ** Math.min(entry.attempts, 6));
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.connectToPeer(url), delay);
    });
  }

  connectToPeers(urls) {
    urls.filter(Boolean).forEach(url => this.connectToPeer(url.trim()));
  }

  setupSocket(socket) {
    socket.peerId = null;
    socket.claimedId = null;
    socket.challenge = crypto.randomBytes(16).toString('hex');
    socket.isAlive = true;
    this.sockets.add(socket);

    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', raw => this.onRaw(socket, raw));
    socket.on('close', () => this.dropSocket(socket));
    socket.on('error', () => this.dropSocket(socket));

    this.sendRaw(socket, 'HELLO', { chainId: this.chainId, genesisHash: this.genesisHash, challenge: socket.challenge });
  }

  dropSocket(socket) {
    this.sockets.delete(socket);
    if (socket.peerId) {
      const set = this.peers.get(socket.peerId);
      if (set) {
        set.delete(socket);
        if (set.size === 0) {
          this.peers.delete(socket.peerId);
          this.emit('peer:disconnected', socket.peerId);
        }
      }
    }
  }

  pingAll() {
    for (const socket of this.sockets) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try { socket.ping(); } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Envelopes
  // ---------------------------------------------------------------------------

  envelope(type, data) {
    const env = { type, from: this.nodeId, ts: Date.now(), data };
    env.sig = sign(this.privateKey, canonicalize(env));
    return env;
  }

  verifyEnvelope(env) {
    if (!env || typeof env !== 'object' || typeof env.type !== 'string') return 'Malformed envelope';
    const member = this.members.get(env.from);
    if (!member) return `Unknown sender ${env.from}`;
    const { sig, ...unsigned } = env;
    if (!verify(member.publicKey, canonicalize(unsigned), sig)) return `Invalid envelope signature (claimed sender ${env.from})`;
    return null;
  }

  onRaw(socket, raw) {
    let env;
    try {
      env = JSON.parse(raw.toString());
    } catch (e) {
      return this.reject(socket, 'Unparseable message');
    }
    const error = this.verifyEnvelope(env);
    if (error) return this.reject(socket, error);

    if (env.type === 'HELLO') {
      const d = env.data || {};
      if (env.from === this.nodeId) {
        // Our own address is in the peer list: stop dialling it, quietly.
        for (const entry of this.outbound.values()) if (entry.socket === socket) entry.self = true;
        try { socket.close(); } catch (e) { /* ignore */ }
        return this.dropSocket(socket);
      }
      if (d.chainId !== this.chainId || d.genesisHash !== this.genesisHash) return this.reject(socket, `Peer ${env.from} is on a different network`);
      if (Math.abs(Date.now() - env.ts) > HELLO_MAX_SKEW_MS) return this.reject(socket, `HELLO from ${env.from} is stale or clock is skewed`);
      if (typeof d.challenge !== 'string' || d.challenge.length < 16) return this.reject(socket, 'HELLO without challenge');
      if (socket.claimedId && socket.claimedId !== env.from) return this.reject(socket, 'Peer changed identity');
      socket.claimedId = env.from;
      // Prove we hold our key by signing the peer's fresh challenge.
      this.sendRaw(socket, 'AUTH', { challenge: d.challenge });
      return;
    }

    if (env.type === 'AUTH') {
      if (!socket.claimedId || env.from !== socket.claimedId) return this.reject(socket, 'AUTH before HELLO');
      if (!env.data || env.data.challenge !== socket.challenge) return this.reject(socket, `AUTH from ${env.from} does not answer our challenge`);
      if (!socket.peerId) {
        socket.peerId = env.from;
        const set = this.peers.get(env.from) || new Set();
        const isNew = set.size === 0;
        set.add(socket);
        this.peers.set(env.from, set);
        if (isNew) {
          this.log.info && this.log.info(`P2P authenticated peer ${env.from}`);
          this.emit('peer:connected', env.from);
        }
      }
      return;
    }

    if (!socket.peerId) return; // must complete HELLO/AUTH first
    if (env.from !== socket.peerId) return this.reject(socket, `Envelope from ${env.from} on socket bound to ${socket.peerId}`);
    this.emit('message', { type: env.type, data: env.data, from: env.from });
  }

  reject(socket, reason) {
    this.log.warn && this.log.warn(`P2P rejected peer: ${reason}`);
    this.emit('peer:rejected', reason);
    try { socket.close(4001, reason.slice(0, 100)); } catch (e) { /* ignore */ }
    this.dropSocket(socket);
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  sendRaw(socket, type, data) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(this.envelope(type, data)));
  }

  socketFor(nodeId) {
    const set = this.peers.get(nodeId);
    if (!set) return null;
    for (const s of set) if (s.readyState === WebSocket.OPEN) return s;
    return null;
  }

  sendTo(nodeId, type, data) {
    const socket = this.socketFor(nodeId);
    if (!socket) return false;
    this.sendRaw(socket, type, data);
    return true;
  }

  /** Send once to every authenticated peer (one socket per node). */
  broadcast(type, data, { except } = {}) {
    if (this.peers.size === 0) return;
    const payload = JSON.stringify(this.envelope(type, data));
    for (const nodeId of this.peers.keys()) {
      if (nodeId === except) continue;
      const socket = this.socketFor(nodeId);
      if (socket) socket.send(payload);
    }
  }

  connectedPeerIds() {
    return Array.from(this.peers.keys()).sort();
  }

  getNetworkStats() {
    return {
      connectedPeers: this.peers.size,
      peers: this.connectedPeerIds(),
      activeConnections: Array.from(this.sockets).filter(s => s.readyState === WebSocket.OPEN).length,
      port: this.port,
      nodeId: this.nodeId
    };
  }
}

module.exports = P2PServer;
