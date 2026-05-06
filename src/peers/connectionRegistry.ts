import { MAX_PEERS, OUTBOUND_PEER_LIMIT } from "@/shared/constants";
import type { PeerConnection } from "@/net/peerConnection";

export class ConnectionRegistry {
  private inboundConnections = new Map<string, PeerConnection>();
  private outboundConnections = new Map<string, PeerConnection>();

  constructor(private readonly logger: any) {}

  registerInbound(connection: PeerConnection): void {
    this.inboundConnections.set(connection.id, connection);
    this.logger.info(
      `Peer connected: ${connection.id}. Active inbound peers: ${this.inboundConnections.size}`,
    );
  }

  registerOutbound(connection: PeerConnection): void {
    this.outboundConnections.set(connection.id, connection);
  }

  unregister(id: string): void {
    if (this.inboundConnections.delete(id)) {
      this.logger.info(
        `Inbound peer disconnected: ${id}. Active inbound peers: ${this.inboundConnections.size}`,
      );
      return;
    }

    if (this.outboundConnections.delete(id)) {
      this.logger.info(
        `Outbound peer disconnected: ${id}. Active outbound peers: ${this.outboundConnections.size}`,
      );
    }
  }

  hasOutbound(id: string): boolean {
    return this.outboundConnections.has(id);
  }

  hasConnection(id: string): boolean {
    return this.inboundConnections.has(id) || this.outboundConnections.has(id);
  }

  get inboundCount(): number {
    return this.inboundConnections.size;
  }

  get outboundCount(): number {
    return this.outboundConnections.size;
  }

  get totalCount(): number {
    return this.inboundCount + this.outboundCount;
  }

  canAcceptInbound(): boolean {
    return this.inboundCount < MAX_PEERS - OUTBOUND_PEER_LIMIT;
  }

  canAcceptOutbound(): boolean {
    return this.outboundCount < OUTBOUND_PEER_LIMIT;
  }

  getConnectedPeers(): PeerConnection[] {
    return [
      ...this.inboundConnections.values(),
      ...this.outboundConnections.values(),
    ];
  }

  getConnectedPeersExcept(peerId: string): PeerConnection[] {
    return this.getConnectedPeers().filter((peer) => peer.id !== peerId);
  }

  closeAll(): void {
    for (const conn of this.inboundConnections.values()) {
      conn.close();
    }
    for (const conn of this.outboundConnections.values()) {
      conn.close();
    }
    this.inboundConnections.clear();
    this.outboundConnections.clear();
    this.logger.info("All peer connections closed");
  }

  destroyAll(): void {
    for (const conn of this.inboundConnections.values()) {
      conn.destroy();
    }
    for (const conn of this.outboundConnections.values()) {
      conn.destroy();
    }
    this.inboundConnections.clear();
    this.outboundConnections.clear();
    this.logger.info("All peer connections destroyed");
  }
}
