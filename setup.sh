#!/bin/sh
# One-time setup: create the permissioned network definition and secrets.
#   ./setup.sh                      4 authorities (tolerates 1 faulty)
#   AUTHORITIES=a,b,c,d,e,f,g ./setup.sh
set -e
cd "$(dirname "$0")"
AUTHORITIES="${AUTHORITIES:-node-1,node-2,node-3,node-4}"
node node/scripts/generate-network.js --out ./network --authorities "$AUTHORITIES" --env ./.env
echo "Next: docker compose up --build"
