import { Socket } from "net";
import { MAX_PEERS, OUTBOUND_PEER_LIMIT } from "@/shared/constants";
import { parsePeerAddress } from "@/shared/utils";
import { ConnectionDirection, type ConnectedPeerContext, type PeerContext } from "@/protocol/types";
import { PeerConnection } from "@/net/peerConnection";

export function handleInboundConnection(socket: Socket, ctx: ConnectedPeerContext) {
  if (!ctx.peerManager.canAcceptInbound(ctx.id)) {
    ctx.logger.warn(
      `Refusing connection from ${ctx.id}: Max peers reached or host is blacklisted.`,
    );
    socket.destroy(); // Hang up immediately
    return;
  }
  new PeerConnection(socket, ctx, ConnectionDirection.INBOUND);
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
  const peersToConnect = OUTBOUND_PEER_LIMIT - ctx.peerManager.outboundConnectionCount;
  const candidates = ctx.peerManager.getOutboundCandidates();

  if (candidates.length === 0) {
    ctx.logger.debug("Discovery loop: No candidates available. Skipping.");
    return;
  }
  const peers = candidates.sort(() => Math.random() - 0.5).slice(0, peersToConnect);
  ctx.logger.info(
    `Discovery loop: Attempting to connect to ${peers.length} peer(s). Outbound: ${ctx.peerManager.outboundConnectionCount}/${OUTBOUND_PEER_LIMIT}, Total: ${ctx.peerManager.totalConnections}/${MAX_PEERS}`,
  );

  for (const peer of peers) {
    const parsed = parsePeerAddress(peer);
    if (!parsed) {
      ctx.logger.warn(`Invalid bootstrap peer: ${peer}`);
      continue;
    }

    const client = new Socket();
    const cleanPeer = parsed.canonical;

    client.setTimeout(2000);

    const connectedContext: ConnectedPeerContext = {
      id: cleanPeer,
      ...ctx,
    };

    client.connect(parsed.port, parsed.dialHost, () => {
      ctx.logger.info(`Successfully connected to ${cleanPeer}!`);
      client.setTimeout(0);
    });
    new PeerConnection(client, connectedContext, ConnectionDirection.OUTBOUND);
  }
}
