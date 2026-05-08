#!/usr/bin/env bash
set -e

cleanup() {
  echo ""
  echo "Shutting down all services..."
  kill $NODE_PID $API_PID $LEDGER_PID 2>/dev/null
  wait $NODE_PID $API_PID $LEDGER_PID 2>/dev/null
  echo "Done."
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "=== Starting Marabu Node (P2P) ==="
bun run src/index.ts &
NODE_PID=$!

echo "=== Starting Marabu API (HTTP) ==="
bun run src/api/index.ts &
API_PID=$!

echo "=== Starting Marabu Ledger (Vite) ==="
cd src/ledger && pnpm dev &
LEDGER_PID=$!

echo ""
echo "All services running:"
echo "  P2P Node  → pid $NODE_PID"
echo "  API       → pid $API_PID  (http://localhost:3000)"
echo "  Ledger UI → pid $LEDGER_PID (http://localhost:5173)"
echo ""
echo "Press Ctrl+C to stop all."

wait
