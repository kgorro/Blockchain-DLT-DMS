> **Note (v2.0):** This document describes the 1.x design. The ledger, consensus and privacy model changed in 2.0. See [README.md](README.md), [SECURITY_MODEL.md](SECURITY_MODEL.md) and [CHANGELOG.md](CHANGELOG.md) for the current system.

# 🔗 Node Roles in Blockchain System

## 📋 Overview of Node Architecture

Your blockchain system has **3 nodes** with different roles and responsibilities. Each node has specific functions for proper network operation.

---

## 🏗️ Node Architecture

### **Multi-Node Setup:**
```
Node 1 (Authority) ←→ Node 2 (Authority) ←→ Node 3 (Authority)
   Port 5001          Port 5002          Port 5003
   P2P 6001           P2P 6002           P2P 6003
   MongoDB 27017      MongoDB 27018      MongoDB 27019
```

---

## 🎯 Node Roles and Responsibilities

### **1. Authority Nodes (All 3 nodes)**
All nodes in your system are **Authority Nodes** - meaning they all have the capability to mine blocks.

#### **Authority Node Capabilities:**
- ✅ **Can Mine Blocks**: Can create new blocks
- ✅ **Can Vote**: Can vote on block validation
- ✅ **Can Validate**: Can validate transactions
- ✅ **Can Store Data**: Store complete blockchain
- ✅ **Can Sync**: Sync with other nodes

#### **Authority Node Responsibilities:**
- **Block Creation**: Create new blocks
- **Transaction Validation**: Validate transactions
- **Consensus Voting**: Vote on block approval
- **Data Synchronization**: Sync data with other nodes
- **Network Maintenance**: Maintain network health

---

## 🔄 Round-Robin Mining System

### **Mining Leader Rotation:**
```
Block #1 → Node 1 (Leader)
Block #2 → Node 2 (Leader)  
Block #3 → Node 3 (Leader)
Block #4 → Node 1 (Leader)
Block #5 → Node 2 (Leader)
...and so on
```

### **How Mining Works:**
1. **Check Turn**: Each node checks if it's the current leader
2. **Create Block**: The leader node creates the block
3. **Broadcast**: Broadcast the block to all nodes
4. **Vote**: All nodes vote on the block
5. **Consensus**: If majority approves, add to blockchain
6. **Next Leader**: Move to next node in rotation

---

## 📊 Detailed Node Functions

### **Node 1 (Port 5001)**
```javascript
// Configuration
PORT=5001
P2P_PORT=6001
NODE_ID=node-1
NODE_TYPE=authority
MONGODB_URI=mongodb://localhost:27017/blockchain-node1
```

#### **Primary Functions:**
- **HTTP API Server**: Handles API requests on port 5001
- **P2P Server**: WebSocket communication on port 6001
- **Database**: MongoDB on port 27017
- **Block Mining**: Can mine blocks
- **Document Processing**: OCR and NLP processing
- **File Storage**: Store uploaded documents

#### **Responsibilities:**
- **API Endpoints**: `/api/documents/upload`, `/api/blockchain/blocks`
- **Document Verification**: File hash verification
- **Search Functionality**: Advanced document search
- **User Authentication**: JWT token management
- **Network Communication**: P2P message handling

### **Node 2 (Port 5002)**
```javascript
// Configuration
PORT=5002
P2P_PORT=6002
NODE_ID=node-2
NODE_TYPE=authority
MONGODB_URI=mongodb://localhost:27018/blockchain-node2
BOOTSTRAP_PEERS=ws://localhost:6001
```

#### **Primary Functions:**
- **HTTP API Server**: Handles API requests on port 5002
- **P2P Server**: WebSocket communication on port 6002
- **Database**: MongoDB on port 27018
- **Block Mining**: Can mine blocks
- **Document Processing**: OCR and NLP processing
- **File Storage**: Store uploaded documents

#### **Responsibilities:**
- **API Endpoints**: Same as Node 1
- **Document Verification**: File hash verification
- **Search Functionality**: Advanced document search
- **User Authentication**: JWT token management
- **Network Communication**: P2P message handling
- **Bootstrap Connection**: Connects to Node 1 as bootstrap peer

### **Node 3 (Port 5003)**
```javascript
// Configuration
PORT=5003
P2P_PORT=6003
NODE_ID=node-3
NODE_TYPE=authority
MONGODB_URI=mongodb://localhost:27019/blockchain-node3
BOOTSTRAP_PEERS=ws://localhost:6001,ws://localhost:6002
```

#### **Primary Functions:**
- **HTTP API Server**: Handles API requests on port 5003
- **P2P Server**: WebSocket communication on port 6003
- **Database**: MongoDB on port 27019
- **Block Mining**: Can mine blocks
- **Document Processing**: OCR and NLP processing
- **File Storage**: Store uploaded documents

#### **Responsibilities:**
- **API Endpoints**: Same as Node 1 and 2
- **Document Verification**: File hash verification
- **Search Functionality**: Advanced document search
- **User Authentication**: JWT token management
- **Network Communication**: P2P message handling
- **Bootstrap Connection**: Connects to Node 1 and 2 as bootstrap peers

---

## 🔄 Node Communication Flow

### **1. Document Upload Process:**
```
User → Node 1 (Upload) → Transaction Creation → 
Broadcast to Node 2 & 3 → Mining (if Node 1's turn) → 
Consensus Voting → Block Addition → Sync to All Nodes
```

### **2. Document Verification:**
```
User → Any Node (Verification) → Hash Calculation → 
Blockchain Search → Result Return
```

### **3. Network Synchronization:**
```
Node A → P2P Message → Node B → Validation → 
Vote → Consensus → Block Addition → Database Update
```

---

## 🎯 Node Specialization

### **All Nodes are Identical in Function:**
- **Same Capabilities**: All have the same functions
- **Same API Endpoints**: All have the same API
- **Same Database Schema**: All have the same database structure
- **Same Processing Power**: All have the same OCR/NLP capabilities

### **Load Balancing:**
- **Round-Robin Mining**: Alternating mining responsibility
- **Distributed Storage**: Each node stores complete blockchain
- **Redundant Processing**: Multiple nodes can handle same request
- **Fault Tolerance**: System works even if 1 node fails

---

## 🔧 Node Configuration

### **Environment Variables:**
```bash
# Node 1
PORT=5001
P2P_PORT=6001
NODE_ID=node-1
NODE_TYPE=authority
MONGODB_URI=mongodb://localhost:27017/blockchain-node1

# Node 2
PORT=5002
P2P_PORT=6002
NODE_ID=node-2
NODE_TYPE=authority
MONGODB_URI=mongodb://localhost:27018/blockchain-node2
BOOTSTRAP_PEERS=ws://localhost:6001

# Node 3
PORT=5003
P2P_PORT=6003
NODE_ID=node-3
NODE_TYPE=authority
MONGODB_URI=mongodb://localhost:27019/blockchain-node3
BOOTSTRAP_PEERS=ws://localhost:6001,ws://localhost:6002
```

### **Database Separation:**
- **Node 1**: `blockchain-node1` database
- **Node 2**: `blockchain-node2` database
- **Node 3**: `blockchain-node3` database
- **Each node**: Has its own MongoDB instance

---

## 📊 Node Status Monitoring

### **Check Node Health:**
```bash
# Check Node 1
curl http://localhost:5001/api/health

# Check Node 2
curl http://localhost:5002/api/health

# Check Node 3
curl http://localhost:5003/api/health
```

### **Check Network Status:**
```bash
# Get network information
curl http://localhost:5001/api/network/status
curl http://localhost:5002/api/network/status
curl http://localhost:5003/api/network/status
```

### **Check Mining Status:**
```bash
# Get mining leader
curl http://localhost:5001/api/mining/leader
curl http://localhost:5002/api/mining/leader
curl http://localhost:5003/api/mining/leader
```

---

## 🔄 Consensus Mechanism

### **Proof of Authority (PoA):**
1. **Pre-approved Validators**: All 3 nodes are authorities
2. **Round-Robin Mining**: Alternating mining responsibility
3. **Voting System**: All nodes vote on blocks
4. **Majority Rule**: Requires majority approval

### **Voting Process:**
```
Block Created → Broadcast to All Nodes → 
Each Node Votes → Count Votes → 
Majority Approval → Block Added to Chain
```

---

## 🛡️ Fault Tolerance

### **Byzantine Fault Tolerance:**
- **3 Nodes**: Can tolerate 1 malicious node
- **5 Nodes**: Can tolerate 1 malicious node
- **7 Nodes**: Can tolerate 2 malicious nodes
- **10 Nodes**: Can tolerate 3 malicious nodes

### **Node Failure Scenarios:**
- **1 Node Down**: System continues to work
- **2 Nodes Down**: System may have issues
- **All Nodes Down**: System completely offline

---

## 📈 Performance per Node

### **Each Node Capabilities:**
- **Block Time**: 3-5 seconds
- **Throughput**: 10-50 documents/minute
- **Storage**: Complete blockchain copy
- **Processing**: OCR, NLP, search functionality
- **Network**: P2P communication

### **Load Distribution:**
- **Mining**: Round-robin rotation
- **API Requests**: Can handle requests on any node
- **Document Processing**: Distributed across nodes
- **Search**: Available on all nodes

---

## 🎯 Summary

### **Node Roles:**
- **Node 1**: Authority node, port 5001, MongoDB 27017
- **Node 2**: Authority node, port 5002, MongoDB 27018
- **Node 3**: Authority node, port 5003, MongoDB 27019

### **All Nodes Have:**
- ✅ **Same Functions**: Identical capabilities
- ✅ **Same API**: Same endpoints
- ✅ **Same Database**: Same schema
- ✅ **Same Processing**: OCR, NLP, search
- ✅ **Same Security**: Authentication, encryption

### **Key Differences:**
- **Port Numbers**: Different HTTP and P2P ports
- **Database**: Separate MongoDB instances
- **Mining**: Round-robin rotation
- **Bootstrap**: Different connection patterns

**All nodes have the same role and capabilities - the only differences are port numbers, database instances, and mining rotation.**
