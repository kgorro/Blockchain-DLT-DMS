# Changelog

## 2.0.0 Ledger hardening and privacy layer

Ledgers created with 1.x are not compatible (1.x blocks had no real signatures or
certificates, so they cannot be verified). Start a new network with `./setup.sh`.

### Ledger and consensus

| 1.x issue | 2.0 fix |
|---|---|
| Block "signature" was SHA-256 of data plus node id; anyone could forge it | Ed25519 key pair per node; proposals, votes and transactions are signed |
| Any peer could declare itself an authority over the network | Fixed authority set with public keys in `network/genesis.json` |
| Votes were unauthenticated; one attacker could vote under many ids | Votes are signed and checked against genesis keys |
| `replaceChain` accepted any longer chain and deleted the stored blocks | Removed. Chains are append-only; sync re-validates every block and certificate |
| `validateChain` skipped signatures and authority checks | Full validation from genesis, also run at startup (detects database tampering) |
| Auto-mining added blocks without waiting for votes; "single authority mode" bypassed consensus | Blocks are final only with a quorum certificate (n - f commit seals) |
| Majority of 3 was described as Byzantine fault tolerant | QBFT-style protocol with quorum n - f; default network is 4 authorities (tolerates 1) |
| Genesis block used `Date.now()`, so every node had a different genesis | Deterministic genesis bound to the hash of `genesis.json` |
| Followers never added blocks after votes arrived; pending pools were never cleared | Prepare/commit/round-change flow, committed transactions removed from every pool |
| No reconnects after a peer dropped | Automatic reconnect with backoff |

### Privacy (Data Privacy Act, RA 10173)

* OCR text, extracted names, titles, emails and file paths are no longer on-chain. Consensus
  rejects any field outside a fixed allowlist.
* Metadata records are encrypted (AES-256-GCM, per-document key) and replicated to authorities;
  a salted commitment on-chain detects tampering.
* Uploaded files are encrypted at rest and served only through the authenticated API.
* New erasure transaction: when finalized, every node deletes the record, key and file.

### Application security

* Removed unauthenticated duplicates of `/api/mine`; `/api/network/peers` and `/api/network/sync`
  now require an admin (previously anyone could make a node connect anywhere).
* Removed the public static `/uploads` route (all uploaded files were downloadable without login).
* Removed the committed `node/.env` (it contained a real JWT secret: **rotate it**, it remains in
  git history) and the hardcoded fallback JWT secret.
* Login throttling, MongoDB operator sanitizing, shell-free OCR commands, random temp file
  names instead of user-supplied file names.

### New

* Merkle inclusion proofs (`/api/documents/:docId/proof`) and lineage (`/api/documents/:docId/lineage`).
* Misbehaviour evidence log (`/api/consensus/evidence`).
* `npm test` (36 tests including attack scenarios) and `npm run bench`.
* Frontend: 4 nodes, secure file viewer, metadata integrity badge, erase button.
