import { Socket } from "net";
import {
  MAX_PEERS,
  MessageType,
  OUTBOUND_PEER_LIMIT,
  SEPARATOR,
} from "./constants";
import { checkHandshake, type ConnectionState } from "./handshake";
import { parseHost, sendMessage } from "./utils";
import { parseMessage } from "./messageParser";
import { messageHandlers } from "./messageHandlers";
import type { PeerManager } from "./peerManager";
import type { DatabaseInterface } from "./db";

export function handleConnection(
  id: string,
  socket: Socket,
  peerManager: PeerManager,
  logger: any,
  db: DatabaseInterface,
) {
  sendMessage(socket, {
    type: MessageType.HELLO,
    version: "0.10.0",
    agent: "Subzero node client",
  });

  sendMessage(socket, {
    type: MessageType.GET_PEERS,
  });

  let buffer = "";
  const state: ConnectionState = { hasHandshaked: false };
  const ctx = {
    id,
    socket,
    peerManager,
    logger,
    db,
  };
  socket.on("data", async (data) => {
    buffer += data.toString();
    const messages = buffer.split(SEPARATOR);
    buffer = messages.pop() || "";
    for (const msg of messages) {
      if (!msg.trim()) {
        logger.error(`Error defragmenting messages`);
        continue;
      }
      const message = parseMessage(msg, ctx);
      if (!message) {
        return;
      }
      if (!checkHandshake(message, socket, state)) {
        return;
      }
      const handler = messageHandlers[message.type];
      if (!handler) {
        logger.error(`No handler found for message type: ${message.type}`);
        continue;
      }
      handler(message, ctx);

      logger.info({ type: message.type }, `[${id}]: Received message`);
    }
  });
}

export function handleInboundConnection(
  socket: Socket,
  peerManager: PeerManager,
  logger: any,
  db: DatabaseInterface,
) {
  const id = `${socket.remoteAddress}:${socket.remotePort}`;
  if (!peerManager.canAcceptInbound()) {
    console.log(`Refusing connection from ${id}: Max peers reached.`);
    socket.destroy(); // Hang up immediately
    return;
  }
  peerManager.onConnectionOpen(id);
  logger.info(
    `Inbound: ${peerManager.inboundConnections.size}. Total: ${peerManager.totalConnections}/${MAX_PEERS}`,
  );
  logger.info(`A new connection has been established from ${id}.`);
  handleConnection(id, socket, peerManager, logger, db);

  socket.on("end", function () {
    logger.info("Closing connection with the client");
    peerManager.onConnectionClose(id);
  });

  socket.on("error", function (err) {
    logger.info(`Error: ${err}`);
    peerManager.onConnectionClose(id);
  });
}

export function handleOutboundConnection(
  peerManager: PeerManager,
  logger: any,
  db: DatabaseInterface,
) {
  if (!peerManager.canAcceptOutbound()) {
    logger.debug("Discovery loop: Outbound peer limit reached. Skipping.");
    return;
  }
  const peersToConnect =
    OUTBOUND_PEER_LIMIT - peerManager.outboundConnections.size;
  const candidates = peerManager.getOutboundCandidates();

  if (candidates.length === 0) {
    logger.debug("Discovery loop: No candidates available. Skipping.");
    return;
  }
  const peers = candidates
    .sort(() => Math.random() - 0.5)
    .slice(0, peersToConnect);
  logger.info(
    `Discovery loop: Attempting to connect to ${peers.length} peer(s). Outbound: ${peerManager.outboundConnections.size}/${OUTBOUND_PEER_LIMIT}, Total: ${peerManager.totalConnections}/${MAX_PEERS}`,
  );

  for (const peer of peers) {
    const { host, port } = parseHost(peer) || {};
    if (!host || !port) {
      logger.warn(`Invalid bootstrap peer: ${peer}`);
      continue;
    }
    //Clean IPV6 host if it's in the format [ipv6]:port
    const cleanHost =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

    const client = new Socket();
    const cleanPeer = `${cleanHost}:${port}`;

    client.setTimeout(2000);

    client.connect(port, cleanHost, () => {
      logger.info(`Successfully connected to ${cleanPeer}!`);
      peerManager.onDialSuccess(peer);
      client.setTimeout(0);
      handleConnection(cleanPeer, client, peerManager, logger, db);
    });

    client.on("error", (err) => {
      logger.warn(
        `Failed to connect to bootstrap peer ${peer}: ${err.message}`,
      );
      peerManager.onDialFail(peer);
      client.destroy();
    });
    client.on("timeout", () => {
      logger.debug(`Connection to ${peer} timed out.`);
      client.destroy();
      peerManager.onDialFail(peer);
    });
  }
}
