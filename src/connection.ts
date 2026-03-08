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
import type { ConnectedPeerContext, PeerContext } from "./types";

export function handleConnection(ctx: ConnectedPeerContext) {
  sendMessage(ctx.socket, {
    type: MessageType.HELLO,
    version: "0.10.0",
    agent: "Subzero node client",
  });

  sendMessage(ctx.socket, {
    type: MessageType.GET_PEERS,
  });

  let buffer = "";
  const state: ConnectionState = { hasHandshaked: false };
  ctx.socket.on("data", async (data) => {
    buffer += data.toString();
    const messages = buffer.split(SEPARATOR);
    buffer = messages.pop() || "";
    for (const msg of messages) {
      if (!msg.trim()) {
        ctx.logger.error(`Error defragmenting messages`);
        continue;
      }
      const message = await parseMessage(msg, ctx);
      if (!message) {
        return;
      }
      if (!checkHandshake(message, ctx.socket, state)) {
        return;
      }
      const handler = messageHandlers[message.type];
      if (!handler) {
        ctx.logger.error(`No handler found for message type: ${message.type}`);
        continue;
      }
      handler(message, ctx);

      ctx.logger.info({ type: message.type }, `[${ctx.id}]: Received message`);
    }
  });
}

export function handleInboundConnection(ctx: ConnectedPeerContext) {
  if (!ctx.peerManager.canAcceptInbound()) {
    console.log(`Refusing connection from ${ctx.id}: Max peers reached.`);
    ctx.socket.destroy(); // Hang up immediately
    return;
  }
  ctx.peerManager.onConnectionOpen(ctx.id);
  ctx.logger.info(
    `Inbound: ${ctx.peerManager.inboundConnections.size}. Total: ${ctx.peerManager.totalConnections}/${MAX_PEERS}`,
  );
  ctx.logger.info(`A new connection has been established from ${ctx.id}.`);
  handleConnection(ctx);
  ctx.socket.on("end", function () {
    ctx.logger.info("Closing connection with the client");
    ctx.peerManager.onConnectionClose(ctx.id);
  });

  ctx.socket.on("error", function (err) {
    ctx.logger.info(`Error: ${err}`);
    ctx.peerManager.onConnectionClose(ctx.id);
  });
}

export function handleOutboundConnection(ctx: PeerContext) {
  if (!ctx.peerManager.canAcceptOutbound()) {
    ctx.logger.debug("Discovery loop: Outbound peer limit reached. Skipping.");
    return;
  }
  const peersToConnect =
    OUTBOUND_PEER_LIMIT - ctx.peerManager.outboundConnections.size;
  const candidates = ctx.peerManager.getOutboundCandidates();

  if (candidates.length === 0) {
    ctx.logger.debug("Discovery loop: No candidates available. Skipping.");
    return;
  }
  const peers = candidates
    .sort(() => Math.random() - 0.5)
    .slice(0, peersToConnect);
  ctx.logger.info(
    `Discovery loop: Attempting to connect to ${peers.length} peer(s). Outbound: ${ctx.peerManager.outboundConnections.size}/${OUTBOUND_PEER_LIMIT}, Total: ${ctx.peerManager.totalConnections}/${MAX_PEERS}`,
  );

  for (const peer of peers) {
    const { host, port } = parseHost(peer) || {};
    if (!host || !port) {
      ctx.logger.warn(`Invalid bootstrap peer: ${peer}`);
      continue;
    }
    //Clean IPV6 host if it's in the format [ipv6]:port
    const cleanHost =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

    const client = new Socket();
    const cleanPeer = `${cleanHost}:${port}`;

    client.setTimeout(2000);

    const connectedContext = {
      id: cleanPeer,
      socket: client,
      ...ctx,
    };
    client.connect(port, cleanHost, () => {
      ctx.logger.info(`Successfully connected to ${cleanPeer}!`);
      ctx.peerManager.onDialSuccess(peer);
      client.setTimeout(0);
      handleConnection(connectedContext);
    });

    client.on("error", (err) => {
      ctx.logger.warn(
        `Failed to connect to bootstrap peer ${peer}: ${err.message}`,
      );
      ctx.peerManager.onDialFail(peer);
      client.destroy();
    });
    client.on("timeout", () => {
      ctx.logger.debug(`Connection to ${peer} timed out.`);
      client.destroy();
      ctx.peerManager.onDialFail(peer);
    });
  }
}
