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

export function handleInboundConnection(
  socket: Socket,
  peerManager: PeerManager,
  logger: any,
) {
  const id = `${socket.remoteAddress}:${socket.remotePort}`;
  if (!peerManager.canAcceptConnection()) {
    console.log(`Refusing connection from ${id}: Max peers reached.`);
    socket.destroy(); // Hang up immediately
    return;
  }
  peerManager.onConnectionOpen(id);
  if (peerManager.has(id)) {
    logger.info(`Peer ${id} has reconnected.`);
  }
  logger.info(`A new connection has been established from ${id}.`);

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
      const message = parseMessage(msg, socket, logger);
      if (!message) {
        return;
      }
      if (!checkHandshake(message, socket, state)) {
        return;
      }
      if (message.type === MessageType.HELLO) {
        await peerManager.add(id);
      }
      const handler = messageHandlers[message.type];
      if (!handler) {
        logger.error(`No handler found for message type: ${message.type}`);
        continue;
      }
      handler(message, ctx);

      logger.info(message, `[${id}]: Received message`);
    }
  });

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
) {
  if (!peerManager.canAcceptConnection()) {
    logger.debug("Discovery loop: Max peers reached. Skipping.");
    return;
  }
  const activePeersCount = peerManager.activeConnections.size;
  if (activePeersCount >= OUTBOUND_PEER_LIMIT) {
    logger.debug("Discovery loop: Outbound peer limit reached. Skipping.");
    return;
  }
  const peersToConnect = OUTBOUND_PEER_LIMIT - activePeersCount;
  const candidates = peerManager.getOutboundCandidates();

  if (candidates.length === 0) {
    logger.debug("Discovery loop: No candidates available. Skipping.");
    return;
  }
  const peers = candidates
    .sort(() => Math.random() - 0.5)
    .slice(0, peersToConnect);
  logger.info(
    `Discovery loop: Attempting to connect to ${peers.length} peer(s). Active peers: ${activePeersCount}/${MAX_PEERS}`,
  );

  for (const peer of peers) {
    if (peerManager.activeConnections.has(peer)) {
      continue;
    }
    const { host, port } = parseHost(peer) || {};
    if (!host || !port) {
      logger.warn(`Invalid bootstrap peer: ${peer}`);
      continue;
    }
    //Clean IPV6 host if it's in the format [ipv6]:port
    const cleanHost =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

    const client = new Socket();

    client.setTimeout(2000);

    client.connect(port, cleanHost, () => {
      logger.info(`Successfully connected to ${peer}!`);
      peerManager.onDialSuccess(peer);
      client.setTimeout(0);
      handleInboundConnection(client, peerManager, logger);
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
