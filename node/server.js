// node/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const Blockchain = require('./blockchain/Blockchain');
const P2PServer = require('./p2p/P2PServer');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const natural = require('natural');
const stopword = require('stopword');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const PublicBlockchainAnchor = require('./anchoring/PublicBlockchainAnchor');
const AuditLogger = require('./audit/AuditLogger');
const BackupManager = require('./backup/BackupManager');

// Initialize Express
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const authRoutes = require('./routes/auth');
const { authenticate, isAdmin, isCitizen } = require('./middleware/auth');

app.use('/api/auth', authRoutes);
// Configuration from environment
const HTTP_PORT = process.env.PORT || 5001;
const P2P_PORT = process.env.P2P_PORT || 6001;
const NODE_ID = process.env.NODE_ID || `node-${HTTP_PORT}`;
const NODE_TYPE = process.env.NODE_TYPE || 'peer';
const IS_AUTHORITY = NODE_TYPE === 'authority';
const MONGODB_URI = process.env.MONGODB_URI || `mongodb://localhost:27017/blockchain-${NODE_ID}`;
const BOOTSTRAP_PEERS = process.env.BOOTSTRAP_PEERS ? process.env.BOOTSTRAP_PEERS.split(',') : [];
const { 
  canAccessDocument, 
  filterAccessibleDocuments,
  sanitizeDocument 
} = require('./middleware/documentAccess');

// Mining lock to prevent concurrent mining
let isMiningInProgress = false;
let miningTimeout = null;

// Initialize blockchain and P2P server
let blockchain;
let p2pServer;
// After blockchain initialization
let publicAnchor;
let auditLogger;
let backupManager;

// ============================================
// NLP & OCR PROCESSING CLASS
// ============================================

class DocumentNLPProcessor {
  constructor() {
    this.tokenizer = new natural.WordTokenizer();
    this.stemmer = natural.PorterStemmer;
    this.tfidf = new natural.TfIdf();
    this.searchIndex = new Map();
  }

  /**
   * Extract text from PDF (handles both text and scanned PDFs)
   */
  async extractTextFromPDF(filePath) {
    console.log('📄 Processing PDF...');
    
    try {
      // Try to extract text directly first
      const dataBuffer = fsSync.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      
      // If text extraction returns meaningful content, use it
      if (pdfData.text && pdfData.text.trim().length > 100) {
        console.log('✅ Text extracted from PDF (text-based)');
        return {
          text: pdfData.text,
          pages: pdfData.numpages,
          method: 'direct'
        };
      }
      
      // Otherwise, it's a scanned PDF - use OCR
      console.log('🔍 PDF appears to be scanned, running OCR...');
      return await this.extractTextFromScannedPDF(filePath);
      
    } catch (error) {
      console.error('❌ PDF processing error:', error);
      return { text: '', pages: 0, method: 'error', error: error.message };
    }
  }

  /**
   * Extract text from scanned PDF using pdftoppm + Tesseract OCR
   * Uses CLI tools only - no npm packages needed
   */
  async extractTextFromScannedPDF(filePath) {
    console.log('🖼️ Converting PDF pages to images for OCR...');
    
    const tempDir = `${filePath}-temp-images`;
    
    try {
      // Create temp directory
      await fs.mkdir(tempDir, { recursive: true });
      
      // Method 1: Try pdftoppm first (most reliable)
      console.log('   Trying pdftoppm...');
      const pdftoppmCmd = `pdftoppm -png -r 300 "${filePath}" "${tempDir}/page"`;
      
      try {
        await execPromise(pdftoppmCmd);
        console.log('   ✅ pdftoppm successful');
      } catch (pdftoppmError) {
        console.log('   ❌ pdftoppm failed, trying GraphicsMagick...');
        
        // Method 2: Fallback to GraphicsMagick
        const gmCmd = `gm convert -density 300 "${filePath}" "${tempDir}/page-%03d.png"`;
        await execPromise(gmCmd);
        console.log('   ✅ GraphicsMagick successful');
      }
      
      // Get list of generated images
      const files = await fs.readdir(tempDir);
      const imageFiles = files.filter(f => f.endsWith('.png')).sort();
      
      if (imageFiles.length === 0) {
        throw new Error('No images generated from PDF');
      }
      
      console.log(`📸 Processing ${imageFiles.length} page(s) with OCR...`);
      
      let fullText = '';
      
      // Process each page with Tesseract
      for (let i = 0; i < imageFiles.length; i++) {
        console.log(`   Processing page ${i + 1}/${imageFiles.length}...`);
        
        const imagePath = path.join(tempDir, imageFiles[i]);
        
        try {
          // Run OCR
          const { data: { text } } = await Tesseract.recognize(imagePath, 'eng', {
            logger: m => {
              if (m.status === 'recognizing text') {
                console.log(`      OCR progress: ${Math.round(m.progress * 100)}%`);
              }
            }
          });
          
          fullText += text + '\n\n';
        } catch (ocrError) {
          console.error(`   Error OCR on page ${i + 1}:`, ocrError.message);
        }
      }
      
      // Clean up temporary images
      console.log('🧹 Cleaning up temporary files...');
      for (const file of imageFiles) {
        try {
          await fs.unlink(path.join(tempDir, file));
        } catch (e) {
          // Ignore
        }
      }
      await fs.rmdir(tempDir);
      
      console.log('✅ OCR completed');
      
      return {
        text: fullText,
        pages: imageFiles.length,
        method: 'ocr'
      };
      
    } catch (error) {
      console.error('❌ OCR processing error:', error);
      
      // Clean up on error
      try {
        const files = await fs.readdir(tempDir);
        for (const file of files) {
          await fs.unlink(path.join(tempDir, file));
        }
        await fs.rmdir(tempDir);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
      return { text: '', pages: 0, method: 'error', error: error.message };
    }
  }

  /**
   * Extract text from image using OCR
   */
  async extractTextFromImage(filePath) {
    console.log('🖼️ Running OCR on image...');
    
    try {
      const { data: { text } } = await Tesseract.recognize(filePath, 'eng', {
        logger: m => {
          if (m.status === 'recognizing text') {
            console.log(`   OCR progress: ${Math.round(m.progress * 100)}%`);
          }
        }
      });
      
      console.log('✅ OCR completed');
      
      return {
        text: text,
        pages: 1,
        method: 'ocr'
      };
      
    } catch (error) {
      console.error('❌ Image OCR error:', error);
      return { text: '', pages: 1, method: 'error', error: error.message };
    }
  }

  /**
   * Process document and extract metadata
   */
  async processDocument(filePath, fileType, fileName) {
    let extractedText = '';
    let extractionMethod = 'none';
    let pageCount = 0;
    
    try {
      // Extract text based on file type
      if (fileType === 'application/pdf') {
        const result = await this.extractTextFromPDF(filePath);
        extractedText = result.text;
        extractionMethod = result.method;
        pageCount = result.pages;
      } else if (fileType.startsWith('image/')) {
        const result = await this.extractTextFromImage(filePath);
        extractedText = result.text;
        extractionMethod = result.method;
        pageCount = result.pages;
      } else if (fileType.startsWith('text/')) {
        extractedText = await fs.readFile(filePath, 'utf-8');
        extractionMethod = 'direct';
        pageCount = 1;
      }

      // Extract NLP metadata
      const metadata = this.extractNLPMetadata(extractedText, fileName);
      
      return {
        extractedText: extractedText.substring(0, 10000),
        fullTextLength: extractedText.length,
        extractionMethod,
        pageCount,
        ...metadata
      };
    } catch (error) {
      console.error('Document processing error:', error);
      return {
        extractedText: '',
        fullTextLength: 0,
        extractionMethod: 'error',
        pageCount: 0,
        keywords: [],
        entities: { people: [], places: [], organizations: [], dates: [] },
        summary: '',
        language: 'unknown',
        sentiment: 'neutral',
        wordCount: 0,
        characterCount: 0,
        error: error.message
      };
    }
  }

  /**
   * Extract NLP metadata from text
   */
  extractNLPMetadata(text, fileName) {
    if (!text || text.trim().length === 0) {
      return {
        keywords: [],
        entities: { people: [], places: [], organizations: [], dates: [] },
        summary: '',
        language: 'unknown',
        sentiment: 'neutral',
        wordCount: 0,
        characterCount: 0
      };
    }

    const keywords = this.extractKeywords(text);
    const entities = this.extractEntitiesSimple(text);
    const sentences = text.match(/[^\.!\?]+[\.!\?]+/g) || [];
    const summary = sentences.slice(0, 3).join(' ').substring(0, 500);
    const language = this.detectLanguage(text);
    const sentiment = this.analyzeSentiment(text);
    
    return {
      keywords,
      entities,
      summary,
      language,
      sentiment,
      wordCount: text.split(/\s+/).length,
      characterCount: text.length
    };
  }

  /**
   * Simple entity extraction using regex
   */
  extractEntitiesSimple(text) {
    const datePattern = /\b\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi;
    const dates = [...new Set(text.match(datePattern) || [])].slice(0, 10);
    
    const capitalizedPattern = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
    const capitalized = [...new Set(text.match(capitalizedPattern) || [])]
      .filter(word => word.length > 3)
      .slice(0, 20);
    
    const people = capitalized.filter(w => 
      /\b(Mr|Mrs|Ms|Dr|Prof)\b/.test(text.substring(Math.max(0, text.indexOf(w) - 10), text.indexOf(w)))
    ).slice(0, 10);
    
    const organizations = capitalized.filter(w => 
      /\b(Inc|Corp|LLC|Ltd|Company|University|Department|Office|Bureau|Agency)\b/.test(w)
    ).slice(0, 10);
    
    const places = capitalized.filter(w => 
      !people.includes(w) && !organizations.includes(w)
    ).slice(0, 10);
    
    return { people, places, organizations, dates };
  }

  /**
   * Extract keywords using TF-IDF
   */
  extractKeywords(text, topN = 15) {
    try {
      let tokens = this.tokenizer.tokenize(text.toLowerCase());
      tokens = stopword.removeStopwords(tokens);
      tokens = tokens.filter(t => t.length > 3 && /^[a-z]+$/.test(t));
      tokens = tokens.map(t => this.stemmer.stem(t));
      
      const frequency = {};
      tokens.forEach(token => {
        frequency[token] = (frequency[token] || 0) + 1;
      });
      
      const sorted = Object.entries(frequency)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([word, count]) => ({ word, count }));
      
      return sorted;
    } catch (error) {
      console.error('Keyword extraction error:', error);
      return [];
    }
  }

  /**
   * Simple language detection
   */
  detectLanguage(text) {
    const englishWords = ['the', 'and', 'is', 'in', 'to', 'of', 'a', 'for'];
    const words = text.toLowerCase().split(/\s+/).slice(0, 100);
    const englishCount = words.filter(w => englishWords.includes(w)).length;
    return englishCount > 5 ? 'english' : 'unknown';
  }

  /**
   * Simple sentiment analysis
   */
  analyzeSentiment(text) {
    try {
      const Analyzer = natural.SentimentAnalyzer;
      const analyzer = new Analyzer('English', this.stemmer, 'afinn');
      const tokens = this.tokenizer.tokenize(text.toLowerCase());
      const score = analyzer.getSentiment(tokens);
      
      if (score > 0.1) return 'positive';
      if (score < -0.1) return 'negative';
      return 'neutral';
    } catch (error) {
      return 'neutral';
    }
  }

  /**
   * Add document to search index
   */
  indexDocument(docId, data) {
    this.searchIndex.set(docId, {
      title: data.title,
      category: data.category,
      extractedText: data.extractedText || '',
      keywords: data.nlpMetadata?.keywords?.map(k => k.word) || [],
      entities: data.nlpMetadata?.entities || { people: [], places: [], organizations: [], dates: [] },
      issuer: data.issuer,
      recipient: data.recipient,
      fileName: data.fileName,
      uploadedAt: data.uploadedAt
    });
    
    console.log(`📇 Document ${docId} indexed for search`);
  }

  /**
   * Advanced search with filters
   */
  search(query, filters = {}) {
    const results = [];
    const queryTokens = this.tokenizer.tokenize(query.toLowerCase());
    const stemmedQuery = queryTokens.map(t => this.stemmer.stem(t));
    
    for (const [docId, doc] of this.searchIndex) {
      let score = 0;
      
      if (!this.matchesFilters(doc, filters)) continue;
      
      if (doc.title.toLowerCase().includes(query.toLowerCase())) score += 10;
      
      const matchedKeywords = doc.keywords.filter(k => 
        stemmedQuery.some(sq => this.stemmer.stem(k).includes(sq))
      );
      score += matchedKeywords.length * 3;
      
      const allEntities = [
        ...doc.entities.people,
        ...doc.entities.places,
        ...doc.entities.organizations
      ];
      const matchedEntities = allEntities.filter(e =>
        e.toLowerCase().includes(query.toLowerCase())
      );
      score += matchedEntities.length * 5;
      
      if (doc.extractedText && doc.extractedText.toLowerCase().includes(query.toLowerCase())) {
        score += 2;
      }
      
      if (doc.category.toLowerCase().includes(query.toLowerCase())) score += 4;
      if (doc.issuer.toLowerCase().includes(query.toLowerCase())) score += 3;
      if (doc.recipient.toLowerCase().includes(query.toLowerCase())) score += 3;
      if (doc.fileName.toLowerCase().includes(query.toLowerCase())) score += 2;
      
      if (score > 0) {
        results.push({ docId, score, doc });
      }
    }
    
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Check if document matches filters
   */
  matchesFilters(doc, filters) {
    if (filters.category && filters.category !== 'all') {
      if (doc.category !== filters.category) return false;
    }
    
    if (filters.dateFrom) {
      const docDate = new Date(doc.uploadedAt);
      const fromDate = new Date(filters.dateFrom);
      if (docDate < fromDate) return false;
    }
    
    if (filters.dateTo) {
      const docDate = new Date(doc.uploadedAt);
      const toDate = new Date(filters.dateTo);
      if (docDate > toDate) return false;
    }
    
    if (filters.issuer && filters.issuer.trim() !== '') {
      if (!doc.issuer.toLowerCase().includes(filters.issuer.toLowerCase())) {
        return false;
      }
    }
    
    if (filters.entity && filters.entity.trim() !== '') {
      const allEntities = [
        ...doc.entities.people,
        ...doc.entities.places,
        ...doc.entities.organizations
      ];
      const hasEntity = allEntities.some(e => 
        e.toLowerCase().includes(filters.entity.toLowerCase())
      );
      if (!hasEntity) return false;
    }
    
    return true;
  }
}

// Initialize NLP Processor
const nlpProcessor = new DocumentNLPProcessor();

// MongoDB Connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(async () => {
  console.log(`✅ MongoDB Connected: ${mongoose.connection.name}`);
  console.log(`📊 Node ID: ${NODE_ID}`);
  console.log(`🔒 Node Type: ${IS_AUTHORITY ? 'AUTHORITY' : 'PEER'}`);
  
  // Initialize blockchain
  blockchain = new Blockchain(NODE_ID, IS_AUTHORITY);
  await blockchain.initialize();
  
  await rebuildSearchIndex();

  // Add this node as authority if it's an authority node
  if (IS_AUTHORITY) {
    blockchain.addAuthority(NODE_ID);
  }
  
  auditLogger = new AuditLogger(NODE_ID);
  console.log('✅ Audit logger initialized');

  // Initialize public blockchain anchor
  publicAnchor = new PublicBlockchainAnchor();
  await publicAnchor.initialize();
  
  // Start periodic anchoring (every hour)
  if (IS_AUTHORITY) {
    publicAnchor.startPeriodicAnchoring(blockchain);
  }

  // Initialize backup manager
  backupManager = new BackupManager(NODE_ID);
  await backupManager.initialize();
  
  // Start periodic backups (every 6 hours)
  if (IS_AUTHORITY) {
    backupManager.startPeriodicBackups(blockchain, 6);
  }

  // Initialize P2P server
  p2pServer = new P2PServer(blockchain, P2P_PORT, NODE_ID);
  p2pServer.listen();
  
  // Connect to bootstrap peers
  if (BOOTSTRAP_PEERS.length > 0) {
    console.log(`🔗 Connecting to bootstrap peers: ${BOOTSTRAP_PEERS.join(', ')}`);
    setTimeout(() => {
      p2pServer.connectToPeers(BOOTSTRAP_PEERS);
    }, 2000);
  }

  setInterval(() => {
    if (p2pServer.peers.length > 0) {
      console.log('🔄 Periodic sync - requesting chain from peers...');
      p2pServer.requestSync();
    }
  }, 15000); // 15 seconds

  // Start HTTP server AFTER blockchain is initialized
  startHTTPServer();
})
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// ============================================
// AUTO-MINING FUNCTION WITH LEADER ELECTION
// ============================================

async function performAutoMining() {
  if (isMiningInProgress) {
    console.log('⚠️  Mining already in progress - skipping');
    return null;
  }

  if (!blockchain.isAuthority) {
    console.log('⚠️  Not an authority node - cannot mine');
    return null;
  }

  // 🎯 KEY CHECK: Is it this node's turn to mine?
  if (!blockchain.isMyTurnToMine()) {
    const currentLeader = blockchain.getMiningLeader();
    console.log(`⏭️  Not my turn to mine. Current leader: ${currentLeader}`);
    return null;
  }

  if (blockchain.pendingTransactions.length === 0) {
    console.log('⚠️  No pending transactions to mine');
    return null;
  }

  isMiningInProgress = true;
  console.log('\n⛏️  AUTO-MINING STARTED (My turn!)');
  console.log(`👑 Mining leader for block #${blockchain.chain.length}: ${NODE_ID}`);
  console.log(`📊 Pending transactions: ${blockchain.pendingTransactions.length}`);

  try {
    // Mine the block
    const block = await blockchain.minePendingTransactions();
    
    if (!block) {
      console.log('❌ Mining returned null');
      return null;
    }
    
    console.log(`✅ Block #${block.index} mined!`);
    console.log(`   Hash: ${block.hash.substring(0, 16)}...`);
    console.log(`   Transactions: ${block.transactions.length}`);
    
    // Vote for own block
    blockchain.voteOnBlock(block.hash, NODE_ID, true);
    console.log(`🗳️  Voted YES on block ${block.hash.substring(0, 8)}...`);
    
    // Check if block already exists (fork detection)
    const existingBlock = blockchain.chain[block.index];
    if (existingBlock) {
      if (existingBlock.hash === block.hash) {
        console.log('✅ Block already in chain - skipping');
        return null;
      } else {
        console.log('⚠️  Fork detected - discarding this block');
        console.log(`   Existing: ${existingBlock.hash.substring(0, 8)}...`);
        console.log(`   New:      ${block.hash.substring(0, 8)}...`);
        
        // Return transactions to pool
        block.transactions.forEach(tx => {
          if (!blockchain.pendingTransactions.some(t => t.timestamp === tx.timestamp)) {
            blockchain.pendingTransactions.push(tx);
          }
        });
        return null;
      }
    }
    
    // Broadcast block first
    p2pServer.broadcastNewBlock(block);
    console.log(`📢 Block broadcasted to ${p2pServer.peers.length} peer(s)`);
    
    // Wait for votes if multiple authorities
    if (blockchain.authorities.size > 1) {
      console.log('⏳ Waiting for consensus votes...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Add block to chain
    console.log('⚡ Adding block to chain...');
    blockchain.chain.push(block);
    await blockchain.saveBlockToDatabase(block);
    blockchain.blockVotes.delete(block.hash);
    
    console.log(`✅ Block #${block.index} added to chain`);
    console.log(`📊 Total blocks now: ${blockchain.chain.length}`);
    console.log('✅ AUTO-MINING COMPLETED\n');
    
    return block;
    
  } catch (error) {
    console.error('\n❌ AUTO-MINING ERROR:');
    console.error(error.message);
    console.error(error.stack);
    return null;
  } finally {
    isMiningInProgress = false;
    miningTimeout = null;
  }
}

// ============================================
// BLOCKCHAIN API ROUTES
// ============================================

app.get('/api/blockchain', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  res.json({
    success: true,
    blockchain: blockchain.export(),
    nodeId: NODE_ID
  });
});

app.get('/api/blockchain/blocks', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  res.json({
    success: true,
    blocks: blockchain.chain.map(b => b.toJSON()),
    count: blockchain.chain.length
  });
});

app.get('/api/blockchain/block/:index', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  const index = parseInt(req.params.index);
  const block = blockchain.chain.find(b => b.index === index);
  
  if (!block) {
    return res.status(404).json({ success: false, error: 'Block not found' });
  }
  
  res.json({ success: true, block: block.toJSON() });
});

app.get('/api/blockchain/verify', async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  const result = await blockchain.verifyChain();
  res.json({ success: true, ...result });
});

app.get('/api/blockchain/statistics', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  const stats = blockchain.getStatistics();
  res.json({ success: true, statistics: stats });
});

// ============================================
// DOCUMENT API ROUTES
// ============================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================
// DOCUMENT UPLOAD API - WITH PRIVACY CONTROLS
// ============================================

app.post('/api/documents/upload', authenticate, isAdmin, upload.single('file'), async (req, res) => {
  if (!blockchain || !p2pServer) {
    return res.status(503).json({ 
      success: false, 
      error: 'System not ready yet. Please wait a moment.' 
    });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { 
      title, 
      category, 
      documentType, 
      issuer, 
      recipient, 
      department, 
      referenceNumber, 
      description,
      // ===== NEW: PRIVACY CONTROLS =====
      privacyLevel,        // 'public', 'confidential', 'restricted', 'citizen-specific'
      allowedRoles,        // JSON string: ['admin', 'department_head', etc.]
      specificCitizens,    // JSON string: ['citizen@example.com', ...]
      expiryDate           // When document becomes public (optional)
    } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, error: 'Document title is required' });
    }

    // ===== NEW: Validate and set privacy level =====
    const validPrivacyLevels = ['public', 'confidential', 'restricted', 'citizen-specific'];
    const documentPrivacy = privacyLevel || 'confidential'; // Default to confidential!

    if (!validPrivacyLevels.includes(documentPrivacy)) {
      return res.status(400).json({ 
        success: false, 
        error: `Invalid privacy level. Must be one of: ${validPrivacyLevels.join(', ')}` 
      });
    }

    // ===== NEW: Parse allowed roles if provided =====
    let parsedAllowedRoles = ['admin']; // Default: only admin
    if (allowedRoles) {
      try {
        parsedAllowedRoles = JSON.parse(allowedRoles);
        if (!Array.isArray(parsedAllowedRoles)) {
          parsedAllowedRoles = ['admin'];
        }
      } catch (e) {
        console.log('⚠️  Invalid allowedRoles format, using default');
      }
    }

    // ===== NEW: Parse specific citizens if provided =====
    let parsedSpecificCitizens = [];
    if (specificCitizens) {
      try {
        parsedSpecificCitizens = JSON.parse(specificCitizens);
        if (!Array.isArray(parsedSpecificCitizens)) {
          parsedSpecificCitizens = [];
        }
      } catch (e) {
        console.log('⚠️  Invalid specificCitizens format, using empty array');
      }
    }

    const crypto = require('crypto');
    const fileBuffer = fsSync.readFileSync(req.file.path);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // ===== EXISTING: PROCESS WITH OCR & NLP =====
    console.log('🤖 Processing document with OCR & NLP...');
    const nlpData = await nlpProcessor.processDocument(
      req.file.path,
      req.file.mimetype,
      req.file.originalname
    );
    console.log('✅ NLP processing complete');

    const transaction = {
      type: 'document',
      timestamp: Date.now(),
      data: {
        title,
        category: category || 'others',
        documentType: documentType || 'Other Document',
        issuer: issuer || 'N/A',
        recipient: recipient || 'N/A',
        department: department || 'N/A',
        referenceNumber: referenceNumber || 'N/A',
        description: description || 'N/A',
        fileName: req.file.originalname,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        fileHash,
        filePath: req.file.path,
        uploadedBy: req.user.username,
        uploadedByRole: req.user.role,
        uploadedByEmail: req.user.email,
        uploadedAt: new Date().toISOString(),
        
        // ===== NEW: ACCESS CONTROL =====
        accessControl: {
          privacyLevel: documentPrivacy,
          allowedRoles: parsedAllowedRoles,
          specificCitizens: parsedSpecificCitizens,
          expiryDate: expiryDate || null,
          isPublic: documentPrivacy === 'public',
          requiresAuthentication: documentPrivacy !== 'public'
        },
        
        // ===== EXISTING: NLP & OCR METADATA =====
        nlpMetadata: {
          extractedText: nlpData.extractedText,
          fullTextLength: nlpData.fullTextLength,
          extractionMethod: nlpData.extractionMethod,
          pageCount: nlpData.pageCount,
          keywords: nlpData.keywords,
          entities: nlpData.entities,
          summary: nlpData.summary,
          language: nlpData.language,
          sentiment: nlpData.sentiment,
          wordCount: nlpData.wordCount,
          characterCount: nlpData.characterCount
        }
      }
    };

    blockchain.addTransaction(transaction);
    console.log(`📄 Transaction added by ${req.user.username} (${req.user.role})`);
    console.log(`🔒 Privacy Level: ${documentPrivacy}`);

    // ===== EXISTING: INDEX FOR SEARCH =====
    nlpProcessor.indexDocument(fileHash, transaction.data);

    // ===== NEW: LOG WITH PRIVACY LEVEL =====
    if (auditLogger) {
      await auditLogger.log(
        'DOCUMENT_UPLOAD',
        {
          username: req.user.username,
          role: req.user.role,
          email: req.user.email,
          ip: req.ip,
          userAgent: req.get('user-agent')
        },
        {
          type: 'document',
          id: fileHash,
          name: title
        },
        {
          fileName: req.file.originalname,
          fileSize: req.file.size,
          category: category,
          privacyLevel: documentPrivacy,
          isPublic: documentPrivacy === 'public',
          blockchainState: {
            blockCount: blockchain.chain.length,
            lastBlockHash: blockchain.chain[blockchain.chain.length - 1]?.hash
          }
        },
        { success: true }
      );
    }

    p2pServer.broadcastTransaction(transaction);
    console.log('📢 Transaction broadcasted to network');

    res.status(201).json({
      success: true,
      message: 'Document uploaded and processed with OCR/NLP',
      transaction,
      fileHash,
      uploadedBy: req.user.username,
      privacyLevel: documentPrivacy, // NEW: Include privacy level in response
      accessControl: transaction.data.accessControl, // NEW: Include access control
      nlpMetadata: transaction.data.nlpMetadata,
      pendingTransactions: blockchain.pendingTransactions.length,
      miningLeader: blockchain.getMiningLeader(),
      isMyTurn: blockchain.isMyTurnToMine()
    });

    // ===== EXISTING: AUTO-MINING LOGIC =====
    if (IS_AUTHORITY && blockchain.isMyTurnToMine() && !isMiningInProgress) {
      console.log('✅ My turn to mine - scheduling auto-mine');
      
      if (miningTimeout) {
        clearTimeout(miningTimeout);
      }
      
      miningTimeout = setTimeout(async () => {
        await performAutoMining();
      }, 2000);
    } else if (!blockchain.isMyTurnToMine()) {
      console.log(`⭐ Not my turn - ${blockchain.getMiningLeader()} will mine`);
    }

  } catch (error) {
    console.error('Upload error:', error);
    
    // ===== NEW: LOG UPLOAD FAILURE =====
    if (auditLogger) {
      await auditLogger.log(
        'DOCUMENT_UPLOAD_FAILED',
        {
          username: req.user.username,
          role: req.user.role,
          email: req.user.email,
          ip: req.ip
        },
        {
          type: 'document',
          name: req.body.title || 'Unknown'
        },
        {
          error: error.message,
          fileName: req.file?.originalname
        },
        { success: false, error: error.message }
      );
    }
    
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/documents/verify', upload.single('file'), async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const crypto = require('crypto');
    const fs = require('fs');
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    fs.unlinkSync(req.file.path);

    let found = null;
    let blockIndex = null;

    for (const block of blockchain.chain) {
      for (const tx of block.transactions) {
        if (tx.data && tx.data.fileHash === fileHash) {
          found = tx;
          blockIndex = block.index;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      return res.json({
        success: true,
        isValid: false,
        message: 'Document not found in blockchain'
      });
    }

    const chainValid = await blockchain.verifyChain();

    res.json({
      success: true,
      isValid: true,
      isChainIntact: chainValid.valid,
      message: 'Document verified successfully',
      document: found.data,
      blockIndex
    });

  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Get all documents - filtered by access control
app.get('/api/documents', async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  const user = req.user || null; // May be guest (null) or authenticated user
  const email = req.query.email || null; // Optional email for email-based access

  const allDocuments = [];
  const documentHashes = new Set();
  
  // Get documents from blockchain
  blockchain.chain.forEach(block => {
    block.transactions.forEach(tx => {
      if (tx.type === 'document' && tx.data) {
        if (!documentHashes.has(tx.data.fileHash)) {
          documentHashes.add(tx.data.fileHash);
          allDocuments.push({
            ...tx.data,
            blockIndex: block.index,
            blockHash: block.hash,
            timestamp: tx.timestamp,
            status: 'confirmed'
          });
        }
      }
    });
  });
  
  // Also check pending transactions
  blockchain.pendingTransactions.forEach(tx => {
    if (tx.type === 'document' && tx.data) {
      if (!documentHashes.has(tx.data.fileHash)) {
        documentHashes.add(tx.data.fileHash);
        allDocuments.push({
          ...tx.data,
          blockIndex: 'pending',
          blockHash: 'pending',
          timestamp: tx.timestamp,
          status: 'pending'
        });
      }
    }
  });

  // CRITICAL: Filter documents based on user access
  const accessibleDocuments = await filterAccessibleDocuments(user, allDocuments, email);

  // Log access attempt
  if (auditLogger) {
    await auditLogger.log(
      'DOCUMENTS_LIST_ACCESS',
      {
        username: user?.username || 'guest',
        role: user?.role || 'guest',
        email: user?.email || email || 'anonymous',
        ip: req.ip
      },
      {
        type: 'document_list',
        totalDocuments: allDocuments.length,
        accessibleDocuments: accessibleDocuments.length
      },
      {
        filtered: allDocuments.length - accessibleDocuments.length,
        withEmail: !!email
      },
      { success: true }
    );
  }

  console.log(`📄 User ${user?.username || email || 'guest'} accessed ${accessibleDocuments.length}/${allDocuments.length} documents`);
  
  res.json({ 
    success: true, 
    documents: accessibleDocuments.sort((a, b) => b.timestamp - a.timestamp),
    count: accessibleDocuments.length,
    totalCount: allDocuments.length,
    accessLevel: user?.role || 'guest',
    chainLength: blockchain.chain.length,
    pendingCount: blockchain.pendingTransactions.length
  });
});

// Get single document with access control
app.get('/api/documents/:fileHash', async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  const { fileHash } = req.params;
  const user = req.user || null;
  const email = req.query.email || null;

  // Find document in blockchain
  let document = null;
  let blockIndex = null;

  for (const block of blockchain.chain) {
    for (const tx of block.transactions) {
      if (tx.type === 'document' && tx.data && tx.data.fileHash === fileHash) {
        document = {
          ...tx.data,
          blockIndex: block.index,
          blockHash: block.hash,
          timestamp: tx.timestamp
        };
        blockIndex = block.index;
        break;
      }
    }
    if (document) break;
  }

  if (!document) {
    return res.status(404).json({ 
      success: false, 
      error: 'Document not found' 
    });
  }

  // CHECK ACCESS CONTROL
  const accessCheck = await canAccessDocument(user, document, email);

  // Log access attempt (success or failure)
  if (auditLogger) {
    await auditLogger.log(
      accessCheck.allowed && accessCheck.level === 'full' ? 'DOCUMENT_ACCESS' : 'DOCUMENT_ACCESS_DENIED',
      {
        username: user?.username || 'guest',
        role: user?.role || 'guest',
        email: user?.email || email || 'anonymous',
        ip: req.ip
      },
      {
        type: 'document',
        id: fileHash,
        name: document.title
      },
      {
        accessReason: accessCheck.reason,
        accessLevel: accessCheck.level,
        privacyLevel: document.accessControl?.privacyLevel || 'unknown'
      },
      { success: accessCheck.allowed && accessCheck.level === 'full' }
    );
  }

  if (!accessCheck.allowed && accessCheck.level !== 'metadata') {
    return res.status(403).json({ 
      success: false, 
      error: 'Access denied',
      reason: accessCheck.reason,
      message: 'You do not have permission to view this document'
    });
  }

  // Return document based on access level
  const returnDoc = accessCheck.level === 'full' 
    ? document 
    : sanitizeDocument(document, accessCheck.level);

  res.json({ 
    success: true, 
    document: returnDoc,
    blockIndex,
    accessLevel: accessCheck.level,
    accessReason: accessCheck.reason,
    canRequest: accessCheck.canRequest,
    expiresAt: accessCheck.expiresAt || null
  });
});

// ============================================
// NETWORK / P2P API ROUTES
// ============================================

app.get('/api/network/status', (req, res) => {
  if (!blockchain || !p2pServer) {
    return res.status(503).json({ success: false, error: 'System not ready yet' });
  }

  res.json({
    success: true,
    node: {
      id: NODE_ID,
      isAuthority: IS_AUTHORITY,
      httpPort: HTTP_PORT,
      p2pPort: P2P_PORT
    },
    network: p2pServer.getNetworkStats(),
    blockchain: blockchain.getStatistics(),
    mining: {
      currentLeader: blockchain.getMiningLeader(),
      isMyTurn: blockchain.isMyTurnToMine(),
      isMining: isMiningInProgress,
      authorityList: blockchain.authorityList
    }
  });
});

// ============================================
// ADVANCED SEARCH API ROUTE
// ============================================

app.post('/api/documents/search/advanced', async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  try {
    const { query, filters } = req.body;

    if (!query || query.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        error: 'Search query is required' 
      });
    }

    console.log(`🔍 Advanced search: "${query}" with filters:`, filters);

    // Perform search using NLP processor
    const searchResults = nlpProcessor.search(query, filters || {});

    // Get full document details for each result
    const detailedResults = [];
    
    for (const result of searchResults) {
      // Find the document in blockchain
      for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
          if (tx.type === 'document' && tx.data && tx.data.fileHash === result.docId) {
            const doc = {
              ...tx.data,
              blockIndex: block.index,
              blockHash: block.hash,
              timestamp: tx.timestamp,
              status: 'confirmed',
              searchScore: result.score
            };
            
            // Apply access control
            const user = req.user || null;
            const accessCheck = await canAccessDocument(user, doc, null);
            
            if (accessCheck.allowed && accessCheck.level === 'full') {
              detailedResults.push(doc);
            } else if (accessCheck.level === 'metadata') {
              // Include metadata-only version
              detailedResults.push(sanitizeDocument(doc, 'metadata'));
            }
            break;
          }
        }
      }
    }

    console.log(`✅ Found ${detailedResults.length} matching documents (from ${searchResults.length} total)`);

    res.json({
      success: true,
      results: detailedResults,
      count: detailedResults.length,
      totalMatches: searchResults.length,
      query: query,
      filters: filters
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Simple search endpoint (for quick searches without filters)
app.get('/api/documents/search', async (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  try {
    const query = req.query.q || req.query.query;

    if (!query || query.trim() === '') {
      return res.status(400).json({ 
        success: false, 
        error: 'Search query parameter "q" is required' 
      });
    }

    console.log(`🔍 Simple search: "${query}"`);

    // Perform search without filters
    const searchResults = nlpProcessor.search(query, {});

    // Get full document details with access control
    const detailedResults = [];
    
    for (const result of searchResults) {
      for (const block of blockchain.chain) {
        for (const tx of block.transactions) {
          if (tx.type === 'document' && tx.data && tx.data.fileHash === result.docId) {
            const doc = {
              ...tx.data,
              blockIndex: block.index,
              blockHash: block.hash,
              timestamp: tx.timestamp,
              status: 'confirmed',
              searchScore: result.score
            };
            
            const user = req.user || null;
            const accessCheck = await canAccessDocument(user, doc, null);
            
            if (accessCheck.allowed && accessCheck.level === 'full') {
              detailedResults.push(doc);
            } else if (accessCheck.level === 'metadata') {
              detailedResults.push(sanitizeDocument(doc, 'metadata'));
            }
            break;
          }
        }
      }
    }

    res.json({
      success: true,
      results: detailedResults,
      count: detailedResults.length,
      query: query
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});
// ============================================
// REBUILD SEARCH INDEX FROM BLOCKCHAIN
// ============================================

async function rebuildSearchIndex() {
  if (!blockchain) {
    console.log('⚠️  Cannot rebuild search index - blockchain not ready');
    return;
  }

  console.log('🔨 Rebuilding search index from blockchain...');
  
  let indexedCount = 0;
  
  // Index all documents from the blockchain
  for (const block of blockchain.chain) {
    for (const tx of block.transactions) {
      if (tx.type === 'document' && tx.data) {
        nlpProcessor.indexDocument(tx.data.fileHash, tx.data);
        indexedCount++;
      }
    }
  }
  
  console.log(`✅ Search index rebuilt: ${indexedCount} documents indexed`);
}

app.get('/api/mining/leader', (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }

  res.json({
    success: true,
    currentLeader: blockchain.getMiningLeader(),
    nextBlockIndex: blockchain.chain.length,
    isMyTurn: blockchain.isMyTurnToMine(),
    nodeId: NODE_ID,
    authorityList: blockchain.authorityList,
    authorities: Array.from(blockchain.authorities)
  });
});

app.post('/api/network/peers', (req, res) => {
  if (!p2pServer) {
    return res.status(503).json({ success: false, error: 'P2P server not initialized yet' });
  }

  const { peerUrl } = req.body;
  
  if (!peerUrl) {
    return res.status(400).json({ success: false, error: 'Peer URL required' });
  }

  p2pServer.connectToPeer(peerUrl);
  res.json({ success: true, message: `Connecting to peer: ${peerUrl}` });
});

app.post('/api/network/sync', (req, res) => {
  if (!p2pServer) {
    return res.status(503).json({ success: false, error: 'P2P server not initialized yet' });
  }

  p2pServer.requestSync();
  res.json({ success: true, message: 'Sync requested from all peers' });
});

app.post('/api/mine', async (req, res) => {
  if (!blockchain || !p2pServer) {
    return res.status(503).json({ success: false, error: 'System not ready yet' });
  }

  if (!IS_AUTHORITY) {
    return res.status(403).json({ success: false, error: 'Only authority nodes can mine blocks' });
  }

  if (!blockchain.isMyTurnToMine()) {
    return res.status(403).json({ 
      success: false, 
      error: 'Not this node\'s turn to mine',
      currentLeader: blockchain.getMiningLeader()
    });
  }

  try {
    const block = await performAutoMining();
    
    if (!block) {
      return res.json({ success: false, message: 'No pending transactions to mine' });
    }

    res.json({
      success: true,
      message: 'Block mined and broadcasted',
      block: block.toJSON()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// HEALTH & INFO ROUTES
// ============================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    nodeId: NODE_ID,
    isAuthority: IS_AUTHORITY,
    blockCount: blockchain ? blockchain.chain.length : 0,
    peers: p2pServer ? p2pServer.getNetworkStats().connectedPeers : 0,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/info', (req, res) => {
  res.json({
    success: true,
    node: {
      id: NODE_ID,
      type: IS_AUTHORITY ? 'authority' : 'peer',
      httpPort: HTTP_PORT,
      p2pPort: P2P_PORT,
      version: '1.0.0'
    },
    blockchain: blockchain ? blockchain.getStatistics() : null,
    network: p2pServer ? p2pServer.getNetworkStats() : null
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ success: false, error: err.message });
});

app.get('/api/blockchain/statistics', authenticate, (req, res) => {
  if (!blockchain) {
    return res.status(503).json({ success: false, error: 'Blockchain not initialized yet' });
  }
  const stats = blockchain.getStatistics();
  res.json({ success: true, statistics: stats });
});

// Admin only: Manual mining
app.post('/api/mine', authenticate, isAdmin, async (req, res) => {
  if (!blockchain || !p2pServer) {
    return res.status(503).json({ success: false, error: 'System not ready yet' });
  }

  if (!IS_AUTHORITY) {
    return res.status(403).json({ success: false, error: 'Only authority nodes can mine blocks' });
  }

  if (!blockchain.isMyTurnToMine()) {
    return res.status(403).json({ 
      success: false, 
      error: 'Not this node\'s turn to mine',
      currentLeader: blockchain.getMiningLeader()
    });
  }

  try {
    const block = await performAutoMining();
    
    if (!block) {
      return res.json({ success: false, message: 'No pending transactions to mine' });
    }

    res.json({
      success: true,
      message: 'Block mined and broadcasted',
      block: block.toJSON(),
      minedBy: req.user.username
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start HTTP server
function startHTTPServer() {
  app.listen(HTTP_PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Node Server Started`);
    console.log(`${'='.repeat(60)}`);
    console.log(`🔌 HTTP API: http://localhost:${HTTP_PORT}`);
    console.log(`🌐 P2P Network: ws://localhost:${P2P_PORT}`);
    console.log(`🆔 Node ID: ${NODE_ID}`);
    console.log(`🔒 Authority: ${IS_AUTHORITY ? 'YES ✅' : 'NO'}`);
    console.log(`📦 Blocks: ${blockchain.chain.length}`);
    console.log(`🔗 Connected Peers: ${p2pServer.getNetworkStats().connectedPeers}`);
    if (IS_AUTHORITY) {
      console.log(`👑 Mining Leader: ${blockchain.getMiningLeader()}`);
      console.log(`🎯 My Turn: ${blockchain.isMyTurnToMine() ? 'YES ✅' : 'NO'}`);
    }
    console.log(`${'='.repeat(60)}\n`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚠️  Shutting down gracefully...');
  
  if (p2pServer) p2pServer.close();
  await mongoose.connection.close();
  
  console.log('✅ Server stopped');
  process.exit(0);
});

module.exports = { app, blockchain, p2pServer };