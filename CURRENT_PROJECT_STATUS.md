> **Note (v2.0):** This document describes the 1.x design. The ledger, consensus and privacy model changed in 2.0. See [README.md](README.md), [SECURITY_MODEL.md](SECURITY_MODEL.md) and [CHANGELOG.md](CHANGELOG.md) for the current system.

# 🔍 Current Blockchain Project Status Guide

## 📋 Understanding Your Brother's Blockchain Project

Your blockchain project is a **Distributed Ledger Technology (DLT)** system designed for government document management and anti-corruption purposes.

---

## 🏗️ Project Structure Overview

### Main Components:
```
Blockchain-DLT-DMS/
├── node/                    # Main blockchain server
│   ├── server.js           # Main application server
│   ├── blockchain/         # Core blockchain logic
│   │   ├── Block.js        # Individual block structure
│   │   └── Blockchain.js   # Blockchain management
│   ├── p2p/                # Peer-to-peer networking
│   │   └── P2PServer.js    # WebSocket communication
│   ├── models/             # Database models
│   │   ├── BlockModel.js   # Block storage schema
│   │   └── User.js         # User management
│   ├── routes/             # API routes
│   │   └── auth.js         # Authentication
│   ├── middleware/          # Security middleware
│   │   └── auth.js         # JWT authentication
│   └── uploads/            # Document storage
├── frontend/               # Web interface (if exists)
├── docker-compose.yml      # Multi-node deployment
└── README.md              # Project documentation
```

---

## 🔍 How to Check Current Blockchain Status

### Method 1: Check if System is Running

#### 1.1 Check Node Health
```bash
# Check if Node 1 is running
curl http://localhost:5001/api/health

# Check if Node 2 is running  
curl http://localhost:5002/api/health

# Check if Node 3 is running
curl http://localhost:5003/api/health
```

**Expected Response:**
```json
{
  "status": "OK",
  "nodeId": "node-1",
  "isAuthority": true,
  "blockCount": 5,
  "peers": 2,
  "timestamp": "2024-12-19T10:30:00.000Z"
}
```

#### 1.2 Check Blockchain Status
```bash
# Get blockchain information
curl http://localhost:5001/api/blockchain

# Get all blocks
curl http://localhost:5001/api/blockchain/blocks

# Get blockchain statistics
curl http://localhost:5001/api/blockchain/statistics
```

### Method 2: Check Database Directly

#### 2.1 MongoDB Connection
```bash
# Connect to MongoDB
mongosh --port 27017

# Check blocks collection
db.blocks.find().sort({index: 1})

# Count total blocks
db.blocks.countDocuments()

# Get latest block
db.blocks.findOne({}, {}, {sort: {index: -1}})
```

#### 2.2 Check File Storage
```bash
# Check uploads directory
ls -la node/uploads/

# Check file sizes and dates
ls -lah node/uploads/
```

### Method 3: Check System Logs

#### 3.1 Application Logs
```bash
# Check if there are log files
ls -la logs/

# View recent logs
tail -f logs/node1.log
tail -f logs/node2.log
tail -f logs/node3.log
```

---

## 📊 What to Look For

### 1. **Blockchain Length**
- **Genesis Block**: Should have at least 1 block (genesis)
- **Document Blocks**: Each uploaded document creates a new block
- **Block Index**: Sequential numbering (0, 1, 2, 3...)

### 2. **Network Status**
- **Connected Peers**: Should show 2+ peers for 3-node setup
- **Authority Nodes**: Should show which nodes can mine
- **Consensus Status**: Should show voting status

### 3. **Document Storage**
- **Uploaded Files**: Check `node/uploads/` directory
- **File Hashes**: Each file has a unique SHA-256 hash
- **Metadata**: Document information stored in blockchain

### 4. **User Accounts**
- **Admin Users**: Check if admin accounts exist
- **Authentication**: JWT tokens for API access
- **Permissions**: Role-based access control

---

## 🚀 How to Start the System

### Option 1: Docker (Easiest)
```bash
# Start all nodes at once
docker-compose up

# Check status
docker-compose ps

# View logs
docker-compose logs
```

### Option 2: Manual Start
```bash
# Terminal 1 - Node 1
PORT=5001 P2P_PORT=6001 NODE_ID=node-1 NODE_TYPE=authority \
MONGODB_URI=mongodb://localhost:27017/blockchain-node1 \
node server.js

# Terminal 2 - Node 2  
PORT=5002 P2P_PORT=6002 NODE_ID=node-2 NODE_TYPE=authority \
MONGODB_URI=mongodb://localhost:27018/blockchain-node2 \
BOOTSTRAP_PEERS=ws://localhost:6001 \
node server.js

# Terminal 3 - Node 3
PORT=5003 P2P_PORT=6003 NODE_ID=node-3 NODE_TYPE=authority \
MONGODB_URI=mongodb://localhost:27019/blockchain-node3 \
BOOTSTRAP_PEERS=ws://localhost:6001,ws://localhost:6002 \
node server.js
```

### Option 3: Startup Script
```bash
# Make script executable
chmod +x startup-script.sh

# Start network
./startup-script.sh
```

---

## 🔍 Understanding the Current State

### 1. **If System is NOT Running:**
- **No Response**: System is not started
- **Connection Refused**: Ports are not open
- **MongoDB Error**: Database not running

### 2. **If System IS Running:**
- **Health Check**: Should return "OK" status
- **Block Count**: Shows number of blocks in chain
- **Peer Count**: Shows connected nodes
- **Authority Status**: Shows if node can mine blocks

### 3. **If Blockchain is Empty:**
- **Block Count = 1**: Only genesis block exists
- **No Documents**: No files uploaded yet
- **Pending Transactions**: May have unprocessed transactions

### 4. **If Blockchain has Data:**
- **Multiple Blocks**: Documents have been uploaded
- **File Hashes**: Each document has unique hash
- **Timestamps**: When documents were uploaded
- **Metadata**: Document information and processing results

---

## 📋 Current State Checklist

### ✅ System Status
- [ ] Are all 3 nodes running?
- [ ] Are nodes connected to each other?
- [ ] Is MongoDB running on all ports?
- [ ] Are there any error messages?

### ✅ Blockchain Status  
- [ ] How many blocks are in the chain?
- [ ] Is the genesis block present?
- [ ] Are there any document blocks?
- [ ] Is the chain valid and synchronized?

### ✅ Document Status
- [ ] Are there any uploaded documents?
- [ ] Are files stored in uploads directory?
- [ ] Are document hashes in blockchain?
- [ ] Are there any pending transactions?

### ✅ Network Status
- [ ] Are all nodes connected?
- [ ] Is consensus working?
- [ ] Are authority nodes functioning?
- [ ] Is P2P communication active?

---

## 🛠️ Troubleshooting Common Issues

### Issue 1: "Connection Refused"
**Problem**: Cannot connect to nodes
**Solution**: 
```bash
# Check if ports are in use
netstat -an | grep 5001
netstat -an | grep 5002  
netstat -an | grep 5003

# Kill processes using ports
sudo lsof -ti:5001 | xargs kill -9
```

### Issue 2: "MongoDB Connection Error"
**Problem**: Database not accessible
**Solution**:
```bash
# Start MongoDB instances
mongod --port 27017 --dbpath ./data/db1 &
mongod --port 27018 --dbpath ./data/db2 &
mongod --port 27019 --dbpath ./data/db3 &
```

### Issue 3: "No Peers Connected"
**Problem**: Nodes not communicating
**Solution**:
```bash
# Check WebSocket ports
netstat -an | grep 6001
netstat -an | grep 6002
netstat -an | grep 6003

# Restart nodes in correct order
```

### Issue 4: "Blockchain Out of Sync"
**Problem**: Nodes have different chains
**Solution**:
```bash
# Force sync from longest chain
curl -X POST http://localhost:5001/api/network/sync
curl -X POST http://localhost:5002/api/network/sync
curl -X POST http://localhost:5003/api/network/sync
```

---

## 📊 Expected Current State

### If System is Fresh (New Installation):
- **Block Count**: 1 (genesis block only)
- **Documents**: 0 uploaded
- **Users**: 0 registered
- **Network**: 3 nodes connected
- **Status**: Ready for first document upload

### If System has been Used:
- **Block Count**: 1+ (genesis + document blocks)
- **Documents**: 1+ uploaded files
- **Users**: 1+ admin accounts
- **Network**: All nodes synchronized
- **Status**: Active and processing documents

### If System has Issues:
- **Block Count**: May be inconsistent across nodes
- **Documents**: May be orphaned or corrupted
- **Users**: Authentication may fail
- **Network**: Nodes may be disconnected
- **Status**: Needs troubleshooting

---

## 🎯 Next Steps Based on Current State

### If System is NOT Running:
1. **Start the system** using one of the methods above
2. **Check for errors** in logs
3. **Verify dependencies** are installed
4. **Test basic functionality**

### If System is Running but Empty:
1. **Create admin account** for authentication
2. **Upload test document** to create first block
3. **Verify document** is stored correctly
4. **Test document verification** functionality

### If System has Data:
1. **Review existing documents** and their metadata
2. **Check blockchain integrity** and synchronization
3. **Test document verification** with existing files
4. **Analyze system performance** and usage patterns

### If System has Issues:
1. **Identify the problem** using diagnostic commands
2. **Fix configuration** or dependency issues
3. **Restart system** with correct settings
4. **Verify functionality** after fixes

---

## 📞 Getting Help

### Quick Diagnostic Commands:
```bash
# Check system status
curl http://localhost:5001/api/health
curl http://localhost:5002/api/health  
curl http://localhost:5003/api/health

# Check blockchain
curl http://localhost:5001/api/blockchain/blocks

# Check documents
curl http://localhost:5001/api/documents

# Check network
curl http://localhost:5001/api/network/status
```

### Log Analysis:
```bash
# Check for errors
grep -i error logs/*.log
grep -i warning logs/*.log
grep -i failed logs/*.log
```

### Database Analysis:
```bash
# Connect to MongoDB
mongosh --port 27017

# Check collections
show collections

# Count documents
db.blocks.countDocuments()
db.users.countDocuments()
```

---

**Your blockchain system is a powerful tool for government document management. Using these diagnostic commands, you can determine the current state of the system and what needs to be done for proper operation.**
