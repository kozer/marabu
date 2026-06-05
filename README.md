# SubZero - Marabu Blockchain Node

P2P blockchain node implementing the [Marabu protocol](https://marabu.dev). Includes a REST API and a web ledger UI for creating transactions.

- **Node** (`src/index.ts`) — P2P node on TCP `:18018`, validates blocks/txs, mines, stores chain in LevelDB
- **API** (`src/api/index.ts`) — Fastify HTTP server, reads UTXOs from node via internal P2P `ledger` message, signs and submits transactions
- **Frontend** (`src/ledger/`) — React + Tailwind v4, displays balance in marabu, builds and sends transactions

**NOTE**: The node deviates from the official protocol, in the following way:
2 new messages have been added ( IHAVELEDGER and LEDGER ), to help api to be decoupled from the node code.

## Setup

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [pnpm](https://pnpm.io) (for the frontend)
- Node.js ≥ 22 (for Vite)

### Install dependencies

```bash
# Root (node + API)
bun install

# Frontend
cd src/ledger && pnpm install
```

### Generate keys (first time only)

```bash
bun create_keys.ts
```

Creates `keys.json` with your public/private key pair. The API uses the private key to sign transactions.

## Running (development)

### Start everything

```bash
bun run dev
# or: bash startAll.sh
```

Starts all three services concurrently. Press `Ctrl+C` to stop all.

### Start individually

```bash
bun run start:node    # P2P node on :18018
bun run start:api     # HTTP API on :3000
bun run start:fe      # Vite frontend on :5173
```

### Open the ledger

```
http://localhost:5173
```

1. Paste your public key (from `keys.json`) → **Check** to see balance
2. Add destination pubkey + marabu amount (e.g. `50`)
3. **Review Transaction** → **Confirm & Send**

The API signs the transaction with your private key and relays it to the node.

## Production deployment

### Docker (recommended)

```bash
# All services
podman compose --profile all up -d

# Individual services
podman compose --profile node up -d     # P2P node :18018
podman compose --profile api up -d      # HTTP API :3000
podman compose --profile ledger up -d   # Frontend :5173

# Stop
podman compose --profile all down
```

Mount volumes for persistence:
- `./peers.json` — bootstrap peer list (node)
- `./marabudb/` — LevelDB chain state (node)
- `./keys.json` — signing key (API)

### Script (legacy)

```bash
bash start_node.sh
```

Uses PM2 (if available) or Podman Compose. Sets `NODE_ENV=production`.

Config via environment:

| Variable | Default | Description |
|---|---|---|
| `SERVER_HOST` | `0.0.0.0` | Bind address |
| `EXTERNAL_PORT` | `18018` | P2P listen port |
| `NODE_HOST` | `127.0.0.1` | API connects to this |
| `NODE_PORT` | `18018` | API connects to this port |
| `LOG_LEVEL` | `info` | pino log level |
| `MINER_ENABLED` | `false` | Enable mining |
| `MINER_TYPE` | `gpu` | `cpu` or `gpu` |
| `OVERRIDE_NODE` | — | Advertise different address (e.g. behind NAT/tunnel) |

## Project structure

```
src/
├── index.ts              # Node entry (P2P server)
├── api/index.ts          # HTTP API (Fastify)
├── protocol/             # Message schemas, validators
├── storage/              # ObjectManager, UtxoStore, BlockManager, Ledger
├── net/                  # TCP connection handling, message dispatch
├── peers/                # Peer discovery and management
├── miners/               # CPU/GPU miners
├── shared/               # Logger, constants, utilities
└── ledger/               # React frontend (separate Vite project)
    └── src/App.tsx       # Main ledger UI
```
