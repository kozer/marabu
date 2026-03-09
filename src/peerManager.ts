import {
  BOOTSTRAP_PEERS,
  INVALID_SELF_HOSTS,
  SERVER_HOST,
  SERVER_PORT,
} from "./constants";
import { normalizePeer, parseHost } from "./utils";
import type { PeerStore } from "./peerStore";
import type { PeerConnection } from "./peerConnection";
import { ConnectionRegistry } from "./connectionRegistry";
import { DialPolicy } from "./dialPolicy";
import ip from "ip";
import { isIP } from "node:net";

export class PeerManager {
  private knownPeers: Set<string>;
  private readonly store: PeerStore;
  private readonly myNode = `${SERVER_HOST}:${SERVER_PORT}`;
  private readonly logger: any;
  private readonly connectionRegistry: ConnectionRegistry;
  private readonly dialPolicy: DialPolicy;

  private toValidatedNormalizedPeer(peer: string): string | null {
    const normalizedPeer = normalizePeer(peer);
    if (
      this.knownPeers.has(normalizedPeer) ||
      !this.isValidPeer(normalizedPeer)
    ) {
      return null;
    }
    return normalizedPeer;
  }

  isValidPeer(peer: string): boolean {
    if (!peer || !peer.trim()) {
      return false;
    }
    if (peer === this.myNode) {
      return false;
    }

    const parsed = parseHost(peer);
    if (!parsed) {
      return false;
    }

    let { host, port } = parsed;

    if (isNaN(port) || port <= 0 || port > 65535) return false;

    const normalizedHost =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

    const lowercaseHost = normalizedHost.toLowerCase();

    const ipType = isIP(normalizedHost); // Returns 0 (DNS), 4 (IPv4), or 6 (IPv6)
    if (
      INVALID_SELF_HOSTS.includes(lowercaseHost) ||
      (ipType === 4 && ip.cidrSubnet("0.0.0.0/8").contains(lowercaseHost))
    ) {
      return false;
    }

    if (ipType !== 0) {
      try {
        if (ip.isLoopback(normalizedHost) || ip.isPrivate(normalizedHost)) {
          return false;
        }
      } catch (e) {
        this.logger.warn(
          `Failed to validate IP address ${normalizedHost}: ${e}`,
        );
        return false;
      }
    }

    return true;
  }

  constructor(store: PeerStore, logger: any) {
    this.store = store;
    this.knownPeers = new Set();
    this.logger = logger;
    this.connectionRegistry = new ConnectionRegistry(logger);
    this.dialPolicy = new DialPolicy(logger);
  }

  hasKnownPeer(peer: string): boolean {
    return this.knownPeers.has(peer);
  }

  getKnownPeers(): string[] {
    return [...this.knownPeers];
  }

  getPeersForAdvertisement(): string[] {
    const peers = this.getKnownPeers();
    if (!peers.includes(this.myNode)) {
      peers.unshift(this.myNode);
    }
    return peers;
  }

  getKnownPeerSet(): ReadonlySet<string> {
    return this.knownPeers;
  }

  async addKnownPeer(peer: string): Promise<void> {
    const normalizedPeer = this.toValidatedNormalizedPeer(peer);
    if (!normalizedPeer) return;

    this.knownPeers.add(normalizedPeer);
    this.logger.info(`Added new peer: ${normalizedPeer}`);
    await this.save();
  }

  async addKnownPeers(peers: string[]): Promise<void> {
    const newPeers: string[] = [];
    for (const peer of peers) {
      const normalizedPeer = this.toValidatedNormalizedPeer(peer);
      if (!normalizedPeer) continue;

      newPeers.push(normalizedPeer);
      this.knownPeers.add(normalizedPeer);
    }
    if (newPeers.length > 0) {
      this.logger.info(
        `Added ${newPeers.length} new peer(s): ${newPeers.join(", ")}`,
      );
      await this.save();
    }
  }

  async load(): Promise<string[]> {
    try {
      const storedPeers = await this.store.load();
      this.logger.info(`My node address: ${this.myNode}`);

      if (storedPeers.length === 0) {
        this.knownPeers = new Set(BOOTSTRAP_PEERS);
        await this.save();
      } else {
        this.knownPeers = new Set(storedPeers);
      }

      this.logger.info(`Loaded ${this.knownPeers.size} peers from storage.`);

      return this.getKnownPeers();
    } catch (err) {
      this.logger.error(err, "Failed to load peers from storage");
      this.knownPeers = new Set([...BOOTSTRAP_PEERS]);
      return this.getKnownPeers();
    }
  }

  async save(): Promise<void> {
    try {
      const peersToPersist = this.getKnownPeers();
      await this.store.save(peersToPersist);
      this.logger.info(`Saved ${peersToPersist.length} peers to storage.`);
    } catch (err) {
      this.logger.error(err, "Failed to save peers to storage");
    }
  }

  registerInboundConnection(connection: PeerConnection): void {
    this.connectionRegistry.registerInbound(connection);
  }

  registerOutboundConnection(connection: PeerConnection): void {
    this.dialPolicy.markSuccess(connection.id);
    this.connectionRegistry.registerOutbound(connection);
    this.logger.info(
      `Outbound peer connected: ${connection.id}. Active outbound peers: ${this.connectionRegistry.outboundCount}`,
    );
  }

  unregisterConnection(id: string): void {
    this.connectionRegistry.unregister(id);
  }

  onDialFail(peer: string): void {
    this.dialPolicy.markFailure(peer);
    this.connectionRegistry.unregister(peer);
  }

  get inboundConnectionCount(): number {
    return this.connectionRegistry.inboundCount;
  }

  get outboundConnectionCount(): number {
    return this.connectionRegistry.outboundCount;
  }

  canAcceptInbound(): boolean {
    return this.connectionRegistry.canAcceptInbound();
  }

  canAcceptOutbound(): boolean {
    return this.connectionRegistry.canAcceptOutbound();
  }

  get totalConnections(): number {
    return this.connectionRegistry.totalCount;
  }

  getConnectedPeers(): PeerConnection[] {
    return this.connectionRegistry.getConnectedPeers();
  }

  getConnectedPeersExcept(peerId: string): PeerConnection[] {
    return this.connectionRegistry.getConnectedPeersExcept(peerId);
  }

  getOutboundCandidates(): string[] {
    return this.getKnownPeers().filter((peer) => {
      if (this.connectionRegistry.hasOutbound(peer) || !this.isValidPeer(peer)) {
        return false;
      }

      return this.dialPolicy.canDial(peer);
    });
  }
}
