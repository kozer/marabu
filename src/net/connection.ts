import { Socket } from "net";
import { MAX_PEERS, OUTBOUND_PEER_LIMIT } from "@/shared/constants";
import { parseHost } from "@/shared/utils";
import type { ConnectedPeerContext, PeerContext } from "@/protocol/types";
import { PeerConnection } from "@/net/peerConnection";

export function handleInboundConnection(ctx: ConnectedPeerContext) {
  if (!ctx.peerManager.canAcceptInbound()) {
    console.log(`Refusing connection from ${ctx.id}: Max peers reached.`);
    ctx.socket.destroy(); // Hang up immediately
    return;
  }
  const connection = new PeerConnection(ctx);
  ctx.peerManager.registerInboundConnection(connection);
  ctx.logger.info(
    `Inbound: ${ctx.peerManager.inboundConnectionCount}. Total: ${ctx.peerManager.totalConnections}/${MAX_PEERS}`,
  );
  ctx.logger.info(`A new connection has been established from ${ctx.id}.`);
}

export function handleOutboundConnection(ctx: PeerContext) {
  if (!ctx.peerManager.canAcceptOutbound()) {
    ctx.logger.debug("Discovery loop: Outbound peer limit reached. Skipping.");
    return;
  }
  const peersToConnect =
    OUTBOUND_PEER_LIMIT - ctx.peerManager.outboundConnectionCount;
  const candidates = ctx.peerManager.getOutboundCandidates();

  if (candidates.length === 0) {
    ctx.logger.debug("Discovery loop: No candidates available. Skipping.");
    return;
  }
  const peers = candidates
    .sort(() => Math.random() - 0.5)
    .slice(0, peersToConnect);
  ctx.logger.info(
    `Discovery loop: Attempting to connect to ${peers.length} peer(s). Outbound: ${ctx.peerManager.outboundConnectionCount}/${OUTBOUND_PEER_LIMIT}, Total: ${ctx.peerManager.totalConnections}/${MAX_PEERS}`,
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
      client.setTimeout(0);
      ctx.peerManager.registerOutboundConnection(connection);
    });
    const connection = new PeerConnection(connectedContext);
  }
}
