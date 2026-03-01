# Marabu

A peer-to-peer blockchain network node implementation written in TypeScript, using the [Bun](https://bun.sh) runtime.

## Overview

Marabu is a node client for a custom blockchain P2P network. Each node:

- Listens for inbound TCP connections from other peers on port **18018**.
- Proactively dials outbound connections to known peers, starting from a set of hard-coded bootstrap peers.
- Exchanges peer lists so that the network self-discovers over time.
- Validates all messages against a strict protocol schema before processing them.

## Project Structure

```
src/
├── index.ts          # Entry point – starts the TCP server and the peer-discovery loop
├── connection.ts     # Low-level connection handling (inbound & outbound)
├── handshake.ts      # Enforces the hello/version handshake before any other messages
├── messageParser.ts  # Parses and validates raw TCP frames into typed messages
├── messageHandlers.ts# One handler per message type (hello, getpeers, peers, …)
├── peerManager.ts    # Tracks known peers, active connections, dial back-off logic
├── peerStore.ts      # Persists the peer address book to disk (peers.json)
├── constants.ts      # Port, bootstrap peers, message type enum, etc.
├── types.ts          # Zod schemas and TypeScript types for every message
├── error.ts          # ProtocolError class and error-code enum
├── utils.ts          # sendMessage, parseHost, normalizePeer helpers
└── logger.ts         # Pino-based structured logger
```

## Protocol

All messages are newline-delimited, canonically serialised JSON (using [canonicalize](https://www.npmjs.com/package/canonicalize)).

### Handshake

Every connection **must** begin with a `hello` message. Any other message received before the handshake is complete causes an `INVALID_HANDSHAKE` error and the connection is closed.

```json
{ "type": "hello", "version": "0.10.0", "agent": "My node" }
```

The version must satisfy the semver range `0.10.x`.

### Supported Message Types

| Type           | Direction        | Description                                   |
|----------------|------------------|-----------------------------------------------|
| `hello`        | bidirectional    | Opens a connection; carries version info      |
| `getpeers`     | bidirectional    | Requests the peer's address book              |
| `peers`        | bidirectional    | Returns a list of known peer addresses        |
| `text`         | inbound          | Free-form text message (<= 20 characters)     |
| `error`        | bidirectional    | Reports a protocol error                      |
| `getchaintip`  | inbound          | Requests the node's current chain tip         |
| `getmempool`   | inbound          | Requests the node's mempool transaction IDs   |
| `mempool`      | bidirectional    | Returns a list of mempool transaction IDs     |

### Error Codes

| Code                      | Meaning                                                    |
|---------------------------|------------------------------------------------------------|
| `INTERNAL_ERROR`          | Node-side processing error                                 |
| `INVALID_FORMAT`          | Message does not match the expected schema                 |
| `UNKNOWN_OBJECT`          | Requested object is unknown to this node                   |
| `UNFINDABLE_OBJECT`       | Requested object cannot be found in the network            |
| `INVALID_HANDSHAKE`       | A non-hello message was received before the handshake      |
| `INVALID_TX_OUTPOINT`     | Transaction outpoint index is out of range                 |
| `INVALID_TX_SIGNATURE`    | Transaction signature is invalid                           |
| `INVALID_TX_CONSERVATION` | Transaction violates the weak law of conservation          |
| `INVALID_BLOCK_COINBASE`  | Block coinbase transaction is invalid                      |
| `INVALID_BLOCK_TIMESTAMP` | Block timestamp is invalid                                 |
| `INVALID_BLOCK_POW`       | Block proof-of-work is invalid                             |
| `INVALID_GENESIS`         | Block has a null previd but is not the genesis block       |

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0

### Install dependencies

```bash
bun install
```

### Run in development mode (hot-reload)

```bash
bun run watch:server
```

### Run once

```bash
bun run dev:server
```

### Build and run the production bundle

```bash
bun run start
```

### Run tests

```bash
bun test
```

### Run tests with coverage

```bash
bun run cov
```

## Docker

A `Dockerfile` and `docker-compose.yml` are provided for containerised deployment.

```bash
# Build and start the node
docker compose up -d
```

The node runs in **host network** mode so that inbound peers can reach it directly on port 18018. Peer state is persisted via a bind-mounted `peers.json` file.

## Configuration

Key settings live in `src/constants.ts`:

| Constant              | Default              | Description                                         |
|-----------------------|----------------------|-----------------------------------------------------|
| `SERVER_PORT`         | `18018`              | TCP port the node listens on                        |
| `SERVER_HOST`         | `0.0.0.0` (dev) / public IP (prod) | Bind address                       |
| `MY_NODE_ADDRESS`     | derived from above   | Address advertised to peers                         |
| `BOOTSTRAP_PEERS`     | three hard-coded IPs | Initial peers used to join the network              |
| `MAX_PEERS`           | `1000`               | Maximum total simultaneous connections              |
| `OUTBOUND_PEER_LIMIT` | `200`                | Maximum outbound connections                        |
| `PEERS_FILE`          | `./peers.json`       | Path to the persistent peer address book            |

## Peer Discovery

1. On startup the node loads previously known peers from `peers.json` and merges them with the bootstrap list.
2. The outbound connection loop runs immediately and then every **60 seconds**, dialling random candidates from the address book.
3. Failed dial attempts trigger an exponential back-off (2^n minutes, where n is the number of consecutive failures).
4. Whenever a peer sends a `peers` message the new addresses are validated and added to the address book.
