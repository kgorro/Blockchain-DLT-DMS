# Blockchain DLT Document Management System

A permissioned distributed ledger for school and government documents. Authority nodes
(registrar, campuses, agencies) jointly finalize document records with a Byzantine fault
tolerant Proof-of-Authority protocol. Personal data is kept off-chain, encrypted, and can be
erased on request, while the ledger keeps a permanent proof that each document existed and
was not altered.

Version 2.0 replaces the original ledger layer. See [SECURITY_MODEL.md](SECURITY_MODEL.md)
for the protocol, threat model and known limitations, and [CHANGELOG.md](CHANGELOG.md) for
what changed from 1.x.

## What the system guarantees

| Property | How |
|---|---|
| Only listed institutions can write | Fixed authority set with Ed25519 public keys in `network/genesis.json`. Every transaction, proposal and vote is signed. |
| No forged or rewritten history | Each block carries a commit certificate: signatures from a quorum of `n - f` authorities. Nodes never replace their chain; sync re-verifies every block. |
| Tolerates faulty authorities | QBFT-style consensus (prepare, commit, round change). With `n = 3f + 1` authorities it stays safe with up to `f` malicious ones and keeps working with up to `f` offline. |
| Tampering with a node's database is detected | The full chain is re-verified at startup and by `GET /api/blockchain/verify`. |
| No personal data on-chain | Consensus rejects any transaction field outside a fixed allowlist. Names, emails, OCR text and file paths live only in the encrypted off-chain store. |
| Right to erasure (RA 10173) | An on-chain erasure transaction makes every authority delete the encrypted record, its key and the file (crypto-shredding). The proof of existence remains. |
| Off-chain metadata integrity | A salted SHA-256 commitment of each metadata record is on-chain. Altered records are flagged as `mismatch`. |
| Verifiable lineage | Documents can link to a parent (`follows`, `supports`, `amends`, `cancels`, `related`). Merkle inclusion proofs and lineage are available through public endpoints. |

## Architecture

```
            +-------------------- authority node --------------------+
 HTTP API   |  app.js           routes, auth, public verification     |
            |  DocumentService  encrypts records/files, erasure       |
            |  Consensus        QBFT-style PoA, sync, evidence        |
            |  Blockchain       validation rules, certificates        |
            |  P2PServer        signed envelopes, challenge handshake |
            |  MongoStore       ledger_blocks, document_records,      |
            |                   document_keys, consensus state        |
            +---------------------------------------------------------+
                    ^   WebSocket (every message signed)   ^
                    v                                       v
              other authority nodes  ...  optional observer nodes
```

On-chain document transaction (everything else is off-chain):

```json
{
  "type": "document",
  "submitter": "node-1",
  "data": {
    "docId": "<sha256 of file>", "fileHash": "<sha256 of file>",
    "category": "academic", "documentType": "Transcript",
    "linkedToDocument": null, "relationshipType": null,
    "recordCommitment": "<sha256 of salted metadata record>",
    "originNode": "node-1", "uploaderRef": "<pseudonymous hash>"
  },
  "id": "<sha256 of the above>", "signature": "<Ed25519 by node-1>"
}
```

## Quick start (Docker)

```bash
./setup.sh                    # creates ./network (genesis + keys) and .env (JWT_SECRET)
docker compose up --build     # 4 authority nodes + MongoDB per node + frontend
```

* Frontend: http://localhost
* Node APIs: http://localhost:5001 ... http://localhost:5004
* Register the first admin on each node you log in to: `POST /api/auth/register` (the first user on a node becomes its admin; later users are created by an admin).

Four authorities are the minimum that tolerate one faulty node. To use more, run
`AUTHORITIES=node-1,node-2,...,node-7 ./setup.sh` and add services to `docker-compose.yml`.

## Running without Docker

```bash
cd node && npm install
node scripts/generate-network.js --out ../network --authorities node-1,node-2,node-3,node-4 --env ../.env
# one MongoDB per node, then for each i in 1..4:
PORT=500$i P2P_PORT=600$i NODE_ID=node-$i MONGODB_URI=mongodb://localhost:27017/node$i \
BOOTSTRAP_PEERS=ws://localhost:6001,ws://localhost:6002,ws://localhost:6003,ws://localhost:6004 \
node server.js
```

## Deploying across institutions

1. One party runs `generate-network.js`, or better, each institution generates its own key
   and sends only its public key to be listed in `genesis.json`.
2. Every server gets the same `genesis.json`, its own `keys/<node>.json`, and `keys/data.key`.
   Never copy one node's private key to another server.
3. Put nodes behind TLS (`wss://`) and restrict the P2P port to the other members.
4. Changing the authority set means a new `genesis.json` (a new network). Online membership
   changes are not implemented yet.

## API

Public (no personal data):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health`, `/api/info` | Node status |
| GET | `/api/blockchain`, `/api/blockchain/blocks?from&limit`, `/api/blockchain/block/:index` | Ledger |
| GET | `/api/blockchain/verify` | Re-verify the whole chain, including certificates |
| GET | `/api/consensus/status`, `/api/network/status`, `/api/mining/leader` | Consensus and peers |
| POST | `/api/documents/verify` (multipart `file`) | Is this exact file registered? Returns block, signers, certificate and Merkle check. Admins also get metadata. |
| GET | `/api/documents/:docId/proof` | Merkle inclusion proof plus block certificate, checkable offline with the keys in genesis.json |
| GET | `/api/documents/:docId/lineage` | Ancestors and descendants |
| GET | `/api/documents`, `/api/documents/:docId`, `/api/documents/related/:docId` | Ledger view for guests, full metadata for admins |

Admin (Bearer token):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/documents/upload` | Multipart `file`, `title`, `category`, `documentType`, `issuer`, `recipient`, `department`, `referenceNumber`, `description`, `keywords`, `enableNLP`, `linkedToDocument`, `relationshipType` |
| GET | `/api/documents/:docId/file` | Decrypted file (on the node that received the upload) |
| POST | `/api/documents/:docId/erase` | `{ "reasonCode": "data_subject_request" \| "inaccurate_data" \| "retention_expired" \| "legal_order" \| "other" }` |
| GET | `/api/documents/search?q=` and POST `/api/documents/search/advanced` | Search over decrypted metadata and OCR text |
| GET | `/api/consensus/evidence` | Recorded misbehaviour (equivocation, conflicting certificates) |
| POST | `/api/network/peers`, `/api/network/sync`, `/api/mine` | Operations |

## Tests and benchmark

```bash
cd node
npm test        # 36 tests: ledger rules, consensus, attacks, privacy layer, HTTP API
npm run bench   # throughput, latency, ledger bytes per document; writes bench/results.json
```

The tests run real WebSocket networks in-process and cover: forged proposer and vote
signatures, impostor and replayed handshakes, a Byzantine authority serving a fake longer
chain, equivocating leaders, round changes under random message delays, offline leaders,
loss of quorum, database tampering, personal fields on-chain, off-chain record tampering,
erasure, and the HTTP permission model.

The benchmark runs every node in one process on one machine, so absolute numbers are a lower
bound. For a paper, run each node on its own machine and report the hardware.

## Project structure

```
node/
  server.js                 startup (MongoDB, network config, components)
  app.js                    HTTP routes
  blockchain/               Block, Transaction (schema allowlist), Blockchain (validation)
  consensus/Consensus.js    QBFT-style PoA consensus and sync
  p2p/P2PServer.js          authenticated WebSocket transport
  documents/DocumentService.js  off-chain encrypted records, erasure, lineage
  crypto/util.js            canonical JSON, Ed25519, Merkle tree, AES-256-GCM
  network/config.js         genesis.json loading and quorum rules
  storage/                  MongoStore (production), MemoryStore (tests)
  nlp/                      OCR and keyword/entity extraction
  scripts/generate-network.js
  test/, bench/
frontend/index.html
```
