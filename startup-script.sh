#!/bin/bash

# Blockchain DLT Network Startup Script
# This script starts a 3-node blockchain network

echo "========================================"
echo "🚀 Starting Blockchain DLT Network"
echo "========================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if MongoDB is running
echo -e "${BLUE}Checking MongoDB...${NC}"
if ! pgrep -x "mongod" > /dev/null; then
    echo -e "${YELLOW}⚠️  MongoDB is not running!${NC}"
    echo "Please start MongoDB first:"
    echo "  mongod --port 27017 --dbpath ./data/db1 &"
    echo "  mongod --port 27018 --dbpath ./data/db2 &"
    echo "  mongod --port 27019 --dbpath ./data/db3 &"
    exit 1
fi
echo -e "${GREEN}✅ MongoDB is running${NC}"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}Installing dependencies...${NC}"
    npm install
    echo ""
fi

# Create uploads directories
mkdir -p uploads1 uploads2 uploads3
echo -e "${GREEN}✅ Upload directories created${NC}"
echo ""

# Start nodes using npm scripts
echo -e "${BLUE}Starting blockchain nodes...${NC}"
echo ""

# Start Node 1
echo -e "${GREEN}🟢 Starting Node 1 (Authority) on ports 5001/6001${NC}"
PORT=5001 P2P_PORT=6001 NODE_ID=node-1 NODE_TYPE=authority MONGODB_URI=mongodb://localhost:27017/blockchain-node1 node server.js > logs/node1.log 2>&1 &
NODE1_PID=$!
echo "Node 1 PID: $NODE1_PID"
sleep 3

# Start Node 2
echo -e "${GREEN}🟢 Starting Node 2 (Authority) on ports 5002/6002${NC}"
PORT=5002 P2P_PORT=6002 NODE_ID=node-2 NODE_TYPE=authority MONGODB_URI=mongodb://localhost:27018/blockchain-node2 BOOTSTRAP_PEERS=ws://localhost:6001 node server.js > logs/node2.log 2>&1 &
NODE2_PID=$!
echo "Node 2 PID: $NODE2_PID"
sleep 3

# Start Node 3
echo -e "${GREEN}🟢 Starting Node 3 (Authority) on ports 5003/6003${NC}"
PORT=5003 P2P_PORT=6003 NODE_ID=node-3 NODE_TYPE=authority MONGODB_URI=mongodb://localhost:27019/blockchain-node3 BOOTSTRAP_PEERS=ws://localhost:6001,ws://localhost:6002 node server.js > logs/node3.log 2>&1 &
NODE3_PID=$!
echo "Node 3 PID: $NODE3_PID"
sleep 3

echo ""
echo "========================================"
echo -e "${GREEN}✅ Network Started Successfully!${NC}"
echo "========================================"
echo ""
echo "📍 Node URLs:"
echo "  Node 1: http://localhost:5001 (P2P: ws://localhost:6001)"
echo "  Node 2: http://localhost:5002 (P2P: ws://localhost:6002)"
echo "  Node 3: http://localhost:5003 (P2P: ws://localhost:6003)"
echo ""
echo "📊 Health Checks:"
echo "  curl http://localhost:5001/api/health"
echo "  curl http://localhost:5002/api/health"
echo "  curl http://localhost:5003/api/health"
echo ""
echo "📝 Logs:"
echo "  tail -f logs/node1.log"
echo "  tail -f logs/node2.log"
echo "  tail -f logs/node3.log"
echo ""
echo "🛑 To stop the network:"
echo "  kill $NODE1_PID $NODE2_PID $NODE3_PID"
echo "  or run: ./stop-network.sh"
echo ""
echo "Save PIDs to file for later shutdown..."
echo "$NODE1_PID $NODE2_PID $NODE3_PID" > .pids

echo "✨ Network is ready for use!"
echo "========================================"
