#!/usr/bin/env node
// node/bench/bench.js
// Reproducible micro-benchmark for the evaluation section of a paper.
// Runs in-process networks (real WebSockets and Ed25519, in-memory storage) and reports:
//   - throughput (finalized transactions per second)
//   - submit-to-finality latency (p50 / p95)
//   - ledger bytes per document, versus the previous design that stored OCR text on-chain
//   - the same with f authorities offline
//
// Usage: node bench/bench.js [--docs 300] [--sizes 4,7,10] [--out bench/results.json]
// Numbers depend on the machine; report hardware with results.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startNetwork, documentTx, waitFor } = require('../test/helpers');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const DOCS = Number(arg('docs', 300));
const SIZES = String(arg('sizes', '4,7,10')).split(',').map(Number);
const OUT = arg('out', path.join(__dirname, 'results.json'));

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function run(n, offline) {
  const ids = Array.from({ length: n }, (_, i) => `node-${i + 1}`);
  const net = await startNetwork({ authorities: ids, roundTimeout: 1000 });
  try {
    const all = Object.values(net.nodes);
    for (let i = 0; i < offline; i++) await all[all.length - 1 - i].stop();
    const live = all.filter(x => x.running);

    const submitted = new Map();
    const latencies = [];
    live[0].bc.on('blockCommitted', block => {
      const now = Date.now();
      for (const tx of block.transactions) {
        if (submitted.has(tx.id)) latencies.push(now - submitted.get(tx.id));
      }
    });

    const start = Date.now();
    for (let i = 0; i < DOCS; i++) {
      const node = live[i % live.length];
      const tx = documentTx(node);
      submitted.set(tx.id, Date.now());
      await node.consensus.submitTransaction(tx);
    }
    const ok = await waitFor(() => live.every(x => x.bc.state.documents.size === DOCS), 120000, 20);
    const elapsed = (Date.now() - start) / 1000;
    if (!ok) {
      for (const x of live) console.error(x.id, 'height', x.bc.height, 'docs', x.bc.state.documents.size, 'pending', x.bc.pending.size, JSON.stringify(x.consensus.getStatus()));
      throw new Error(`n=${n}: not all documents finalized`);
    }

    const blocks = live[0].bc.chain.slice(1);
    const ledgerBytes = blocks.reduce((s, b) => s + JSON.stringify(b.toJSON()).length, 0);
    return {
      authorities: n,
      offline,
      quorum: live[0].bc.quorum,
      documents: DOCS,
      blocks: blocks.length,
      seconds: Number(elapsed.toFixed(2)),
      throughputTxPerSec: Number((DOCS / elapsed).toFixed(1)),
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      ledgerBytesPerDocument: Math.round(ledgerBytes / DOCS)
    };
  } finally {
    await net.stop();
  }
}

/** Size of one transaction in the previous design (OCR text, entities, names on-chain). */
function legacyTxBytes() {
  const ocr = 'Lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(180).slice(0, 10000); // previous cap: 10,000 chars
  return JSON.stringify({
    type: 'document', timestamp: Date.now(),
    data: {
      title: 'Transcript of Records - Juan Dela Cruz', category: 'academic', documentType: 'Transcript',
      issuer: 'Office of the Registrar', recipient: 'Juan Dela Cruz', department: 'College of Technology',
      referenceNumber: 'TOR-2026-00123', description: 'Official transcript', manualKeywords: ['tor', 'transcript'],
      linkedToDocument: null, relationshipType: null, fileName: 'tor-juan-dela-cruz.pdf', fileSize: 245760,
      fileType: 'application/pdf', fileHash: 'f'.repeat(64), filePath: '/app/uploads/1700000000000-123-tor-juan-dela-cruz.pdf',
      uploadedBy: 'registrar', uploadedByRole: 'admin', uploadedByEmail: 'registrar@ctu.example',
      uploadedAt: new Date().toISOString(), nlpEnabled: true,
      nlpMetadata: {
        extractedText: ocr, fullTextLength: 24000, extractionMethod: 'ocr', pageCount: 3,
        keywords: Array.from({ length: 15 }, (_, i) => ({ word: `keyword${i}`, count: 3 })),
        entities: { people: ['Juan Dela Cruz'], places: ['Carmen', 'Cebu'], organizations: ['Department of Education'], dates: ['March 3, 2026'] },
        summary: ocr.slice(0, 500), language: 'english', sentiment: 'neutral', wordCount: 4000, characterCount: 24000
      }
    }
  }).length;
}

(async () => {
  const results = [];
  for (const n of SIZES) {
    process.stdout.write(`n=${n} all online... `);
    results.push(await run(n, 0));
    console.log('done');
    const f = Math.floor((n - 1) / 3);
    if (f > 0) {
      process.stdout.write(`n=${n} with f=${f} offline... `);
      results.push(await run(n, f));
      console.log('done');
    }
  }
  const legacy = legacyTxBytes();
  console.log('\nauthorities offline quorum blocks  tx/s   p50ms  p95ms  bytes/doc');
  for (const r of results) {
    console.log(`${String(r.authorities).padEnd(12)}${String(r.offline).padEnd(8)}${String(r.quorum).padEnd(7)}${String(r.blocks).padEnd(7)}${String(r.throughputTxPerSec).padEnd(7)}${String(r.latencyP50Ms).padEnd(7)}${String(r.latencyP95Ms).padEnd(7)}${r.ledgerBytesPerDocument}`);
  }
  console.log(`\nPrevious design, one document transaction with OCR metadata on-chain: ~${legacy} bytes (before block overhead)`);

  const report = {
    generatedAt: new Date().toISOString(),
    machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0] && os.cpus()[0].model, memoryGb: Math.round(os.totalmem() / 1e9), node: process.version },
    documentsPerRun: DOCS,
    results,
    legacyOnChainBytesPerDocument: legacy
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`Saved ${OUT}`);
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
