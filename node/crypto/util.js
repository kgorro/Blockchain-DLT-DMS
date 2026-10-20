// node/crypto/util.js
// Cryptographic primitives used by the ledger and the privacy layer.
// Everything here uses Node's built-in crypto module (no extra dependencies).
const crypto = require('crypto');

/**
 * Deterministic JSON serialization: object keys are sorted recursively and
 * undefined values are dropped. Hashes and signatures are always computed over
 * this form so that every node derives identical bytes from identical data.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(v => (v === undefined ? 'null' : canonicalize(v))).join(',') + ']';
  }
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashObject(obj) {
  return sha256(canonicalize(obj));
}

// ---------------------------------------------------------------------------
// Ed25519 signatures
// ---------------------------------------------------------------------------

/** Generate an Ed25519 key pair. Public key is base64 SPKI DER, private key is PKCS8 PEM. */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

const publicKeyCache = new Map();
function toPublicKeyObject(publicKeyB64) {
  let key = publicKeyCache.get(publicKeyB64);
  if (!key) {
    key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    publicKeyCache.set(publicKeyB64, key);
  }
  return key;
}

function toPrivateKeyObject(privateKey) {
  return typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
}

function derivePublicKey(privateKey) {
  return crypto.createPublicKey(toPrivateKeyObject(privateKey))
    .export({ type: 'spki', format: 'der' }).toString('base64');
}

function sign(privateKey, message) {
  return crypto.sign(null, Buffer.from(message), toPrivateKeyObject(privateKey)).toString('base64');
}

function verify(publicKeyB64, message, signatureB64) {
  if (!publicKeyB64 || typeof signatureB64 !== 'string') return false;
  try {
    return crypto.verify(null, Buffer.from(message), toPublicKeyObject(publicKeyB64), Buffer.from(signatureB64, 'base64'));
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Merkle tree over transaction ids (enables compact inclusion proofs)
// ---------------------------------------------------------------------------

const EMPTY_ROOT = sha256('');

function merkleRoot(leaves) {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = leaves.map(l => sha256('leaf:' + l));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256('node:' + level[i] + right));
    }
    level = next;
  }
  return level[0];
}

/** Inclusion proof for leaves[index]: list of { hash, position } siblings from leaf to root. */
function merkleProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new Error('Leaf index out of range');
  const proof = [];
  let level = leaves.map(l => sha256('leaf:' + l));
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : (idx + 1 < level.length ? idx + 1 : idx);
    proof.push({ hash: level[siblingIdx], position: isRight ? 'left' : 'right' });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256('node:' + level[i] + right));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function verifyMerkleProof(leaf, proof, root) {
  let hash = sha256('leaf:' + leaf);
  for (const step of proof) {
    hash = step.position === 'left'
      ? sha256('node:' + step.hash + hash)
      : sha256('node:' + hash + step.hash);
  }
  return hash === root;
}

// ---------------------------------------------------------------------------
// AES-256-GCM for off-chain records, files and key wrapping
// ---------------------------------------------------------------------------

function randomKey() {
  return crypto.randomBytes(32);
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
}

/** Binary file format: 12-byte IV | 16-byte tag | ciphertext */
function encryptBuffer(key, buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(key, data) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}

module.exports = {
  canonicalize,
  sha256,
  hashObject,
  generateKeyPair,
  derivePublicKey,
  sign,
  verify,
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
  randomKey,
  encrypt,
  decrypt,
  encryptBuffer,
  decryptBuffer
};
