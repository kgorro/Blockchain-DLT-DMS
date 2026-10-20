#!/bin/bash
# Start a 4-authority network locally without Docker.
# Requires MongoDB on ports 27017-27020 (one instance per node), e.g.:
#   for p in 27017 27018 27019 27020; do mkdir -p data/db$p; mongod --port $p --dbpath data/db$p --fork --logpath data/db$p.log; done
set -e
cd "$(dirname "$0")"

[ -f network/genesis.json ] || ./setup.sh
set -a; [ -f .env ] && . ./.env; set +a
(cd node && [ -d node_modules ] || npm install)
mkdir -p logs

PEERS="ws://localhost:6001,ws://localhost:6002,ws://localhost:6003,ws://localhost:6004"
for i in 1 2 3 4; do
  PORT=500$i P2P_PORT=600$i NODE_ID=node-$i NETWORK_DIR="$PWD/network" UPLOADS_DIR="$PWD/uploads$i" \
  MONGODB_URI="mongodb://localhost:$((27016 + i))/blockchain-node$i" BOOTSTRAP_PEERS="$PEERS" \
    node node/server.js > logs/node$i.log 2>&1 &
  echo "node-$i started (HTTP 500$i, P2P 600$i), PID $!, log logs/node$i.log"
done
echo "Stop with: pkill -f 'node node/server.js'"
