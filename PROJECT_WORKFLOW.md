> **Note (v2.0):** This document describes the 1.x design. The ledger, consensus and privacy model changed in 2.0. See [README.md](README.md), [SECURITY_MODEL.md](SECURITY_MODEL.md) and [CHANGELOG.md](CHANGELOG.md) for the current system.

# 🔄 Blockchain DLT Project Workflow

## 📋 System Overview

Our blockchain DLT system is a distributed document management system that uses Proof of Authority (PoA) consensus mechanism for transparent and secure storage of government documents.

---

## 🏗️ Architecture Components

### 1. **Core Blockchain Layer**
```
┌─────────────────────────────────────────────────────────┐
│                    BLOCKCHAIN LAYER                     │
├─────────────────────────────────────────────────────────┤
│  • Block.js - Individual block structure               │
│  • Blockchain.js - Core blockchain logic              │
│  • BlockModel.js - MongoDB schema                      │
│  • Consensus mechanism (Proof of Authority)            │
│  • Transaction validation                              │
│  • Block mining and verification                       │
└─────────────────────────────────────────────────────────┘
```

### 2. **P2P Network Layer**
```
┌─────────────────────────────────────────────────────────┐
│                   P2P NETWORK LAYER                    │
├─────────────────────────────────────────────────────────┤
│  • P2PServer.js - WebSocket communication             │
│  • Node discovery and connection management            │
│  • Message broadcasting                               │
│  • Heartbeat monitoring                              │
│  • Chain synchronization                             │
│  • Consensus voting                                   │
└─────────────────────────────────────────────────────────┘
```

### 3. **Application Layer**
```
┌─────────────────────────────────────────────────────────┐
│                  APPLICATION LAYER                      │
├─────────────────────────────────────────────────────────┤
│  • server.js - Main application server                │
│  • Document upload and processing                      │
│  • OCR and NLP processing                             │
│  • Authentication and authorization                   │
│  • RESTful API endpoints                             │
│  • Search and verification                            │
└─────────────────────────────────────────────────────────┘
```

### 4. **Data Layer**
```
┌─────────────────────────────────────────────────────────┐
│                     DATA LAYER                          │
├─────────────────────────────────────────────────────────┤
│  • MongoDB - Block and transaction storage            │
│  • File system - Document storage                      │
│  • Search index - Document indexing                   │
│  • User database - Authentication data                │
└─────────────────────────────────────────────────────────┘
```

---

## 🔄 Complete Workflow Process

### Phase 1: System Initialization

#### 1.1 Node Startup
```
🚀 Node Startup Process:
    ↓
📊 Load configuration (PORT, P2P_PORT, NODE_ID, etc.)
    ↓
🗄️ Connect to MongoDB database
    ↓
⛓️ Initialize blockchain from database
    ↓
🌐 Start P2P server (WebSocket)
    ↓
🔗 Connect to bootstrap peers
    ↓
🔄 Sync with network
    ↓
✅ Node ready for operations
```

#### 1.2 Network Formation
```
🌐 Network Formation:
    ↓
🔍 Node discovers other peers
    ↓
🤝 Establishes WebSocket connections
    ↓
📊 Exchanges node information
    ↓
⛓️ Syncs blockchain data
    ↓
🗳️ Establishes consensus mechanism
    ↓
✅ Network fully operational
```

### Phase 2: Document Upload Workflow

#### 2.1 Document Processing
```
📄 Document Upload Process:
    ↓
🔐 User authentication (JWT token)
    ↓
📁 File upload via multipart form
    ↓
🔒 Generate SHA-256 hash of file
    ↓
🤖 Optional: OCR/NLP processing
    ↓
📝 Create transaction with metadata
    ↓
➕ Add transaction to pending pool
    ↓
📢 Broadcast transaction to network
    ↓
⏳ Wait for mining
```

#### 2.2 Transaction Mining
```
⛏️ Mining Process:
    ↓
🎯 Check if it's this node's turn to mine
    ↓
📦 Create block with pending transactions
    ↓
🔐 Sign block with authority signature
    ↓
📢 Broadcast block to network
    ↓
🗳️ Network votes on block validity
    ↓
📊 Check consensus (majority approval)
    ↓
✅ Add block to blockchain
    ↓
🔄 Sync block to all nodes
```

#### 2.3 Consensus Mechanism
```
🗳️ Consensus Process:
    ↓
📦 Authority node creates block
    ↓
📢 Broadcasts block to all peers
    ↓
🔍 Each node validates block
    ↓
🗳️ Each authority node votes (YES/NO)
    ↓
📊 Count votes and check majority
    ↓
✅ If majority approves: Add to chain
    ↓
❌ If majority rejects: Discard block
    ↓
🔄 All nodes sync final decision
```

### Phase 3: Document Verification Workflow

#### 3.1 Verification Process
```
🔍 Document Verification:
    ↓
📄 User uploads file for verification
    ↓
🔐 System calculates file hash
    ↓
🔍 Search blockchain for matching hash
    ↓
📊 Check if document exists in chain
    ↓
✅ If found: Return verification result
    ↓
❌ If not found: Return "not verified"
    ↓
📋 Provide block information and timestamp
```

### Phase 4: Search and Retrieval

#### 4.1 Advanced Search
```
🔍 Search Process:
    ↓
📝 User enters search query
    ↓
🔍 System searches indexed documents
    ↓
📊 Apply filters (category, date, issuer, etc.)
    ↓
📈 Calculate relevance scores
    ↓
📋 Return ranked results
    ↓
🔗 Provide links to original documents
```

---

## 🔧 Technical Implementation Details

### 1. **Blockchain Structure**

#### Block Format:
```javascript
{
  index: 0,                    // Block number
  timestamp: 1640995200000,    // Unix timestamp
  transactions: [...],          // Array of transactions
  previousHash: "0",           // Hash of previous block
  hash: "abc123...",          // Current block hash
  nonce: 0,                   // Mining nonce
  authority: "node-1",        // Authority node ID
  signature: "def456...",     // Authority signature
  metadata: {...}             // Additional metadata
}
```

#### Transaction Format:
```javascript
{
  type: "document",           // Transaction type
  timestamp: 1640995200000,   // Transaction timestamp
  data: {
    title: "Document Title",
    category: "administrative",
    fileHash: "sha256hash...",
    fileName: "document.pdf",
    fileSize: 1024000,
    uploadedBy: "admin",
    nlpMetadata: {...}       // NLP processing results
  }
}
```

### 2. **P2P Communication Protocol**

#### Message Types:
```javascript
const MESSAGE_TYPES = {
  CHAIN_REQUEST: 'CHAIN_REQUEST',      // Request blockchain
  CHAIN_RESPONSE: 'CHAIN_RESPONSE',    // Send blockchain
  NEW_BLOCK: 'NEW_BLOCK',              // New block broadcast
  NEW_TRANSACTION: 'NEW_TRANSACTION',  // New transaction
  BLOCK_VOTE: 'BLOCK_VOTE',            // Vote on block
  NODE_DISCOVERY: 'NODE_DISCOVERY',    // Node discovery
  NODE_INFO: 'NODE_INFO',              // Node information
  HEARTBEAT: 'HEARTBEAT',              // Keep-alive
  SYNC_REQUEST: 'SYNC_REQUEST'          // Request sync
};
```

#### Message Format:
```javascript
{
  type: "NEW_BLOCK",
  data: {
    block: {...},           // Block data
    nodeId: "node-1"        // Sender node ID
  }
}
```

### 3. **Consensus Algorithm**

#### Proof of Authority (PoA):
```
1. Pre-approved authority nodes only
2. Round-robin mining rotation
3. Fast block finalization (3-5 seconds)
4. Energy efficient (no mining competition)
5. Government controlled validators
```

#### Voting Process:
```
1. Authority node creates block
2. Broadcasts to all peers
3. Each authority node validates
4. Each authority node votes (YES/NO)
5. Check if majority approves (>50%)
6. Add block to chain if approved
7. Sync to all nodes
```

### 4. **Security Measures**

#### Cryptographic Security:
- **SHA-256 Hashing**: For file integrity
- **Digital Signatures**: For block authentication
- **JWT Tokens**: For user authentication
- **Encrypted Communications**: WebSocket over TLS

#### Network Security:
- **Firewall Protection**: Network-level security
- **Access Control**: Role-based permissions
- **Audit Logging**: Complete activity logs
- **Regular Backups**: Data protection

---

## 📊 Performance Metrics

### System Performance:
- **Block Time**: 3-5 seconds
- **Throughput**: 10-50 documents/minute
- **Consensus Time**: 1-3 seconds
- **Network Latency**: <100ms (local)
- **Fault Tolerance**: Up to 33% malicious nodes

### Scalability:
- **3 nodes**: Development environment
- **5-7 nodes**: Production environment
- **10+ nodes**: High availability
- **100+ nodes**: Global distribution

---

## 🔄 Data Flow Diagram

### Document Upload Flow:
```
User → API → Authentication → File Processing → Transaction Creation → 
Blockchain → P2P Broadcast → Consensus → Block Addition → Database Sync
```

### Document Verification Flow:
```
User → API → File Hash Calculation → Blockchain Search → 
Result Verification → Response to User
```

### Network Sync Flow:
```
Node A → P2P Message → Node B → Validation → Vote → 
Consensus Check → Block Addition → Database Update
```

---

## 🛠️ Development Workflow

### 1. **Local Development**
```bash
# Start MongoDB instances
mongod --port 27017 --dbpath ./data/db1 &
mongod --port 27018 --dbpath ./data/db2 &
mongod --port 27019 --dbpath ./data/db3 &

# Start blockchain nodes
PORT=5001 P2P_PORT=6001 NODE_ID=node-1 node server.js &
PORT=5002 P2P_PORT=6002 NODE_ID=node-2 node server.js &
PORT=5003 P2P_PORT=6003 NODE_ID=node-3 node server.js &
```

### 2. **Docker Deployment**
```bash
# Start entire network
docker-compose up

# Access nodes
curl http://localhost:5001/api/health
curl http://localhost:5002/api/health
curl http://localhost:5003/api/health
```

### 3. **Testing Workflow**
```bash
# Upload document
curl -X POST http://localhost:5001/api/documents/upload \
  -F "file=@test.pdf" \
  -F "title=Test Document"

# Verify document
curl -X POST http://localhost:5002/api/documents/verify \
  -F "file=@test.pdf"

# Check blockchain
curl http://localhost:5001/api/blockchain/blocks
```

---

## 📈 Monitoring and Maintenance

### 1. **Health Monitoring**
- Node status monitoring
- Network connectivity checks
- Database health monitoring
- Performance metrics tracking

### 2. **Log Management**
- Application logs
- Error tracking
- Security audit logs
- Performance logs

### 3. **Backup Strategy**
- Regular database backups
- File system backups
- Blockchain state snapshots
- Disaster recovery procedures

---

## 🎯 Anti-Corruption Benefits

### 1. **Transparency**
- All transactions are publicly visible
- Real-time monitoring capabilities
- Complete audit trail
- Public access to documents

### 2. **Immutability**
- Documents cannot be altered
- Permanent record keeping
- Tamper-proof system
- Forensic evidence capability

### 3. **Accountability**
- Clear ownership of actions
- Digital signatures
- Timestamp verification
- User activity tracking

### 4. **Efficiency**
- Automated processes
- Reduced human intervention
- Faster processing times
- Cost savings

---

## 🔮 Future Enhancements

### 1. **Smart Contracts**
- Automated compliance checking
- Conditional document processing
- Automated approvals
- Rule-based workflows

### 2. **Mobile Integration**
- Mobile document upload
- QR code verification
- Offline capability
- Push notifications

### 3. **AI Integration**
- Fraud detection algorithms
- Pattern recognition
- Anomaly detection
- Predictive analytics

### 4. **Interoperability**
- Cross-agency integration
- International standards
- API standardization
- Third-party integrations

---

## 📋 Implementation Checklist

### Phase 1: Foundation ✅
- [x] Core blockchain implementation
- [x] Basic document upload/verification
- [x] Multi-node setup
- [x] Authentication system

### Phase 2: Enhancement 🔄
- [ ] Advanced search functionality
- [ ] OCR and NLP processing
- [ ] User interface development
- [ ] API documentation

### Phase 3: Production 🔄
- [ ] Security hardening
- [ ] Performance optimization
- [ ] Deployment automation
- [ ] Monitoring and logging

### Phase 4: Expansion 🔄
- [ ] Additional use cases
- [ ] Integration with existing systems
- [ ] Mobile application
- [ ] Advanced analytics

---

**This blockchain DLT system is ready for implementation and can start with a pilot project within 3 months. The system is designed for transparency, security, and efficiency in government operations.**
