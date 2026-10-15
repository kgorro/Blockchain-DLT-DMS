# Security Model

This document states what the ledger protects against, how, and what it does not cover.
It is written so it can be adapted into the system design and threat model sections of a paper.

## Participants

* **Authority nodes** (n of them): institutions that hold an Ed25519 signing key listed in
  `genesis.json`. They submit transactions, propose blocks and vote.
* **Observer nodes** (optional): listed in `genesis.json` with a key, sync and verify the
  ledger, never vote, hold no document data.
* **Admins**: authenticated users of one authority node who upload, view and erase documents.
* **Public verifiers**: anyone holding a file, checking it through the public API or offline.

## Assumptions

* At most f = floor((n - 1) / 3) authorities are Byzantine (arbitrary behaviour, including
  colluding). Recommended n: 4 (f = 1), 7 (f = 2), 10 (f = 3).
* Private keys of honest authorities are not compromised.
* Liveness assumes partial synchrony: after some point, messages between honest nodes arrive
  within the round timeout. Safety does not depend on timing.
* Standard cryptographic assumptions for Ed25519, SHA-256 and AES-256-GCM.

## Consensus (QBFT-style Proof of Authority)

Quorum Q = n - f. For height h and round r, the leader is `authorities[(h + r) mod n]`
(authorities sorted by id, fixed by genesis).

1. **Proposal.** The leader signs `PROPOSAL|chain|h|r|blockHash`. In round r > 0 the proposal
   must include Q valid ROUND-CHANGE messages for r. If any of them reports a prepared block,
   the leader must re-propose the one prepared in the highest round.
2. **Prepare.** Each authority accepts the first valid proposal of its current round and signs
   `PREPARE|chain|h|r|blockHash`. The accepted proposal is persisted before the vote is sent.
3. **Commit.** On Q prepares for (h, r, B) the node records B as prepared (with the prepare
   certificate, persisted) and signs the commit seal `COMMIT|chain|h|blockHash`.
4. **Finalize.** Q commit seals for B finalize it. The seals are stored in the block as its
   certificate, so any node can verify finality later without trusting the sender.
5. **Round change.** On timeout (base timeout doubling up to 8x) a node signs
   `ROUND_CHANGE|chain|h|r+1|preparedRound|preparedHash` and attaches its prepared block and
   prepare certificate. f + 1 round-change messages for higher rounds pull a lagging node forward.

**Safety argument.** Two quorums of size n - f intersect in at least n - 2f >= f + 1 nodes,
so in at least one honest node. An honest node prepares at most one block per round, so at most
one block can be prepared per round. If B is finalized at round r, at least f + 1 honest nodes
prepared B in r; any justification for a later round contains at least one of them, and the
highest prepared block it carries is B (no other block can gather a prepare certificate in
a round >= r without honest nodes contradicting the justification rule). Every later proposal
at that height is therefore B. This is the standard QBFT/IBFT 2.0 argument.

**Implemented validation on every block (proposal, broadcast or sync):** chain id, index,
previous hash, timestamp monotonic and not more than 60 s in the future, Merkle root of
transactions, block hash, proposer is the leader for (index, block round), proposer signature,
every transaction (signature by an authority, id, schema allowlist, no duplicates, lineage
parent exists, erasure target exists), and for finalized blocks a certificate of >= Q distinct
valid authority seals.

**What nodes never do:** replace their chain with a "longer" one, delete stored blocks, accept
authority status claimed over the network, or count a signature whose key is not in genesis.

## Transport

* Every P2P message is an envelope `{type, from, ts, data, sig}` signed by the sender.
* Handshake: HELLO (chain id, genesis hash, random challenge), answered by AUTH signing the
  peer's challenge. A recorded HELLO cannot be replayed to take over a peer slot.
* After the handshake a socket is bound to one node id; envelopes from another id close it.
* Votes and proposals carry their own inner signatures, so relayed messages stay verifiable.
* Transport encryption is not built in: deploy with `wss://` (TLS) between institutions.

## Privacy layer

| Data | Where | Protection |
|---|---|---|
| File hash, category, type, lineage link, origin node, pseudonymous uploader ref, metadata commitment | On-chain, replicated, permanent | Integrity via consensus; contains no direct personal data |
| Title, issuer, recipient, description, keywords, OCR text, entities, file name, uploader | `document_records`, every authority | AES-256-GCM with a random per-document key |
| Per-document key | `document_keys`, every authority | Wrapped with the network data key (`keys/data.key`) |
| File bytes | `uploads/<docId>.bin`, origin node only | AES-256-GCM with the per-document key |

* The commitment is SHA-256 over the canonical record, which includes a random 128-bit salt,
  so low-entropy metadata cannot be guessed from the ledger.
* Replicated records are accepted only if they decrypt and match the on-chain commitment.
* **Erasure.** `POST /api/documents/:docId/erase` submits a signed erasure transaction. When it
  is finalized, every authority deletes the record, the wrapped key and the file. The ledger
  keeps the document hash, its block and the erasure entry (reason code, time, pseudonymous
  requester), so authenticity of a copy can still be checked but its metadata is gone.
* Consensus rejects any on-chain field outside the allowlist in `blockchain/Transaction.js`,
  so personal data cannot be added to the ledger by mistake or by a modified client.

## Application security

* JWT secret must come from the environment (no built-in default); tokens expire in 12 h.
* Login attempts are throttled per IP; MongoDB query operators are stripped from input
  (`sanitizeFilter`); OCR helpers run without a shell.
* Uploads are written to a private temp directory under random names; the stored file is
  encrypted and served only to admins through the API (no static `/uploads`).
* Administrative endpoints (`/api/mine`, `/api/network/*`, erasure, evidence) require an admin.

## Evidence of misbehaviour

Recorded in `consensus_evidence` and exposed at `GET /api/consensus/evidence` (admin):
a leader signing two proposals for the same round, an authority signing conflicting prepares or
commits in the same round, and any received block that conflicts with a finalized block while
carrying a valid certificate (which would mean more than f authorities misbehaved).

## Known limitations

* **Membership changes** require a new genesis (new network). On-chain voting to add or
  remove authorities is future work.
* **Data key sharing.** All authorities share `data.key`, so each can decrypt every record. This
  is intended (any authority may serve a verification request) but means a compromised
  authority exposes all non-erased records. Per-institution access control or threshold
  decryption would narrow this.
* **Crypto-shredding scope.** Erasure removes data from live databases and the upload folder.
  Backups made before the erasure still hold ciphertext; the backup policy should exclude
  `document_keys` or expire them, otherwise those backups remain decryptable.
* **File hash on-chain.** A party that already holds a copy of an erased file can still prove it
  was registered. This is intended (proof of existence) but should be stated in the privacy notice.
* **Files are stored on the origin node only** (not replicated) to keep storage small. If that
  node's disk is lost, the hash and metadata survive but the file must be restored from backup.
* **Users are per node.** Admin accounts are not replicated across institutions.
* **Frontend** renders some metadata with innerHTML; a content security policy and output
  escaping should be added before production use.
* The benchmark runs all nodes in one process; publish multi-machine measurements.
