// node/nlp/DocumentNLPProcessor.js
// OCR + lightweight NLP used to index documents for search. Extracted text and
// entities are personal data, so they are stored only in the encrypted off-chain
// record and in this in-memory index, never on the ledger.
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const natural = require('natural');
const stopword = require('stopword');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

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
      try {
        await execFilePromise('pdftoppm', ['-png', '-r', '300', filePath, path.join(tempDir, 'page')]);
        console.log('   ✅ pdftoppm successful');
      } catch (pdftoppmError) {
        console.log('   ❌ pdftoppm failed, trying GraphicsMagick...');
        
        // Method 2: Fallback to GraphicsMagick
        await execFilePromise('gm', ['convert', '-density', '300', filePath, path.join(tempDir, 'page-%03d.png')]);
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
      extractedText: data.extractedText || (data.nlpMetadata && data.nlpMetadata.extractedText) || '',
      keywords: [
        ...(data.nlpMetadata?.keywords?.map(k => k.word) || []),
        ...(data.manualKeywords || [])
      ],
      entities: data.nlpMetadata?.entities || { people: [], places: [], organizations: [], dates: [] },
      issuer: data.issuer || '',
      recipient: data.recipient || '',
      fileName: data.fileName || '',
      uploadedAt: data.uploadedAt
    });
  }

  removeDocument(docId) {
    this.searchIndex.delete(docId);
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
      
      if ((doc.title || '').toLowerCase().includes(query.toLowerCase())) score += 10;
      
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
      
      if ((doc.category || '').toLowerCase().includes(query.toLowerCase())) score += 4;
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

module.exports = DocumentNLPProcessor;
