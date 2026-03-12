import {
  BOOTSTRAP_PEERS,
  INVALID_MESSAGE_BLACKLIST_TTL,
  INVALID_MESSAGE_THRESHOLD,
  INVALID_SELF_HOSTS,
  MAX_PEERS_FROM_MESSAGE,
  MAX_PEERS_PER_SOURCE,
  SERVER_HOST,
  SERVER_PORT,
  STALE_PEER_MAX_AGE_TTL,
} from "@/shared/constants";
import { normalizePeer, parsePeerAddress } from "@/shared/utils";
import type { PeerStore } from "@/peers/peerStore";
import type { PeerConnection } from "@/net/peerConnection";
import { ConnectionRegistry } from "@/peers/connectionRegistry";
import ip from "ip";
import { isIP } from "node:net";
import type { ValidMessage } from "@/protocol/types";

type KnownPeerRecord = {
  discoveredAt: number;
  introducedBy: Set<string>;
};

type PenaltyRecord = {
  failureCount: number;
  invalidMessageCount: number;
  lastFailureAt?: number;
  blacklistedExpiresAt?: number;
};

export class PeerManager {
  private knownPeers: Map<string, KnownPeerRecord>;
  private penalties: Map<string, PenaltyRecord>;
  private readonly store: PeerStore;
  private readonly myNode = `${SERVER_HOST}:${SERVER_PORT}`;
  private readonly logger: any;
  private readonly connectionRegistry: ConnectionRegistry;

  constructor(store: PeerStore, logger: any) {
    this.store = store;
    this.knownPeers = new Map();
    this.penalties = new Map();
    this.logger = logger;
    this.connectionRegistry = new ConnectionRegistry(logger);
  }

  private getOrCreatePeerRecord(
    peer: string,
    sourcePeerId?: string,
  ): KnownPeerRecord {
    const existing = this.knownPeers.get(peer);
    if (existing) {
      if (sourcePeerId) {
        existing.introducedBy.add(sourcePeerId);
      }
      return existing;
    }

    const created: KnownPeerRecord = {
      discoveredAt: Date.now(),
      introducedBy: sourcePeerId ? new Set([sourcePeerId]) : new Set(),
    };
    this.knownPeers.set(peer, created);
    return created;
  }

  private toPenaltyKey(address: string): string | null {
    const parsed = parsePeerAddress(address);
    if (!parsed) {
      return null;
    }

    return parsed.dialHost.toLowerCase();
  }

  private getOrCreatePenalty(key: string): PenaltyRecord {
    const existing = this.penalties.get(key);
    if (existing) {
      return existing;
    }

    const created: PenaltyRecord = {
      failureCount: 0,
      invalidMessageCount: 0,
    };
    this.penalties.set(key, created);
    return created;
  }

  private clearConnectionBackoff(address: string): void {
    const penaltyKey = this.toPenaltyKey(address);
    if (!penaltyKey) {
      return;
    }

    const penalty = this.getOrCreatePenalty(penaltyKey);
    penalty.failureCount = 0;
    delete penalty.lastFailureAt;
  }

  private isBlacklisted(address: string, now = Date.now()): boolean {
    const penaltyKey = this.toPenaltyKey(address);
    if (!penaltyKey) {
      return false;
    }

    const penalty = this.penalties.get(penaltyKey);
    if (!penalty?.blacklistedExpiresAt) {
      return false;
    }

    if (penalty.blacklistedExpiresAt <= now) {
      delete penalty.blacklistedExpiresAt;
      return false;
    }
    return true;
  }

  private canAcceptFromSource(sourcePeerId?: string): boolean {
    if (!sourcePeerId) {
      return true;
    }

    let count = 0;
    for (const record of this.knownPeers.values()) {
      if (record.introducedBy.has(sourcePeerId)) {
        count += 1;
      }
    }
    return count < MAX_PEERS_PER_SOURCE;
  }

  private shouldPrunePeer(record: KnownPeerRecord, now = Date.now()): boolean {
    return now - record.discoveredAt >= STALE_PEER_MAX_AGE_TTL;
  }

  async pruneStalePeers(now = Date.now()): Promise<number> {
    let peersToRemove = 0;

    for (const [peer, record] of this.knownPeers.entries()) {
      if (!this.shouldPrunePeer(record, now)) {
        continue;
      }

      this.knownPeers.delete(peer);
      peersToRemove += 1;
    }

    if (peersToRemove > 0) {
      this.logger.info(
        `Pruned ${peersToRemove} stale peer(s) from address book.`,
      );
    }

    return peersToRemove;
  }

  private isHostAllowedToConnect(peer: string, now = Date.now()): boolean {
    const penaltyKey = this.toPenaltyKey(peer);
    if (!penaltyKey) {
      return true;
    }

    const penalty = this.penalties.get(penaltyKey);
    if (!penalty) {
      return true;
    }

    if (this.isBlacklisted(peer, now)) {
      return false;
    }

    if (!penalty.lastFailureAt || penalty.failureCount === 0) {
      return true;
    }

    const cooldown = Math.pow(2, penalty.failureCount) * 60 * 1000;
    return now - penalty.lastFailureAt >= cooldown;
  }

  private toValidatedNormalizedPeer(peer: string): string | null {
    const normalizedPeer = normalizePeer(peer);
    if (
      this.knownPeers.has(normalizedPeer) ||
      this.isBlacklisted(normalizedPeer) ||
      !this.isAcceptablePeer(normalizedPeer)
    ) {
      return null;
    }
    return normalizedPeer;
  }

  isAcceptablePeer(peer: string): boolean {
    if (!peer || !peer.trim()) {
      return false;
    }
    if (peer === this.myNode) {
      return false;
    }

    const parsed = parsePeerAddress(peer);
    if (!parsed) {
      return false;
    }

    const { dialHost: host, port } = parsed;

    if (isNaN(port) || port <= 0 || port > 65535) return false;

    const lowercaseHost = host.toLowerCase();
    const ipType = isIP(host);
    if (ipType === 0 && !host.includes(".")) {
      return false;
    }

    if (
      INVALID_SELF_HOSTS.includes(lowercaseHost) ||
      (ipType === 4 && ip.cidrSubnet("0.0.0.0/8").contains(host))
    ) {
      return false;
    }

    if (ipType !== 0) {
      try {
        if (ip.isLoopback(host) || ip.isPrivate(host)) {
          return false;
        }
      } catch (e) {
        this.logger.warn(`Failed to validate IP address ${host}: ${e}`);
        return false;
      }
    }

    return true;
  }
  getKnownPeers(): string[] {
    return [...this.knownPeers.keys()];
  }

  getPeersForAdvertisement(): string[] {
    const peers = this.getKnownPeers().filter(
      (peer) => this.isAcceptablePeer(peer) && !this.isBlacklisted(peer),
    );
    if (!peers.includes(this.myNode)) {
      peers.unshift(this.myNode);
    }
    return peers;
  }

  getKnownPeerSet(): ReadonlySet<string> {
    return new Set(this.knownPeers.keys());
  }

  async addKnownPeers(peers: string[], sourcePeerId?: string): Promise<void> {
    const newPeers: string[] = [];
    for (const peer of peers.slice(0, MAX_PEERS_FROM_MESSAGE)) {
      if (!this.canAcceptFromSource(sourcePeerId)) {
        this.logger.warn(
          `Rejecting additional peers from ${sourcePeerId}: per-source cap reached.`,
        );
        break;
      }

      const normalizedPeer = this.toValidatedNormalizedPeer(peer);
      if (!normalizedPeer) continue;

      newPeers.push(normalizedPeer);
      this.getOrCreatePeerRecord(normalizedPeer, sourcePeerId);
    }
    if (newPeers.length > 0) {
      await this.pruneStalePeers();
      this.logger.info(
        `Added ${newPeers.length} new peer(s): ${newPeers.join(", ")}`,
      );
      await this.save();
    }
  }

  async load(): Promise<string[]> {
    try {
      const storedState = await this.store.load();
      const storedPeers = storedState.peers;
      const peersToLoad =
        storedPeers.length === 0 ? BOOTSTRAP_PEERS : storedPeers;
      this.logger.info(`My node address: ${this.myNode}`);

      for (const peer of peersToLoad) {
        const normalizedPeer = this.toValidatedNormalizedPeer(peer);
        if (!normalizedPeer) {
          continue;
        }

        this.getOrCreatePeerRecord(normalizedPeer);
      }

      if (storedPeers.length === 0) {
        await this.save();
      }

      this.logger.info(`Loaded ${this.knownPeers.size} peers from storage.`);

      return this.getKnownPeers();
    } catch (err) {
      this.logger.error(err, "Failed to load peers from storage");
      for (const peer of BOOTSTRAP_PEERS) {
        const normalizedPeer = this.toValidatedNormalizedPeer(peer);
        if (!normalizedPeer) {
          continue;
        }

        this.getOrCreatePeerRecord(normalizedPeer);
      }
      return this.getKnownPeers();
    }
  }

  async save(): Promise<void> {
    try {
      const peersToPersist = this.getKnownPeers();
      await this.store.save({
        peers: peersToPersist,
      });
      this.logger.info(`Saved ${peersToPersist.length} peers to storage.`);
    } catch (err) {
      this.logger.error(err, "Failed to save peers to storage");
    }
  }

  registerInboundConnection(connection: PeerConnection): void {
    this.clearConnectionBackoff(connection.id);
    this.connectionRegistry.registerInbound(connection);
  }

  registerOutboundConnection(connection: PeerConnection): void {
    this.clearConnectionBackoff(connection.id);
    this.connectionRegistry.registerOutbound(connection);
    this.logger.info(
      `Outbound peer connected: ${connection.id}. Active outbound peers: ${this.connectionRegistry.outboundCount}`,
    );
  }

  unregisterConnection(id: string): void {
    this.connectionRegistry.unregister(id);
  }

  async reportConnectionFailure(address: string): Promise<void> {
    const penaltyKey = this.toPenaltyKey(address);
    if (!penaltyKey) {
      return;
    }

    const penalty = this.getOrCreatePenalty(penaltyKey);
    penalty.failureCount += 1;
    penalty.lastFailureAt = Date.now();

    const removedPeers = await this.pruneStalePeers();
    if (removedPeers > 0) {
      await this.save();
    }
  }

  async reportInvalidPeerMessage(peer: string, reason: string): Promise<void> {
    const penaltyKey = this.toPenaltyKey(peer);
    if (!penaltyKey) {
      this.logger.warn(`Unknown peer ${peer} sent invalid data: ${reason}`);
      return;
    }

    const penalty = this.getOrCreatePenalty(penaltyKey);
    penalty.invalidMessageCount += 1;
    this.logger.warn(
      `Peer ${peer} sent invalid data (${penalty.invalidMessageCount}): ${reason}`,
    );

    if (penalty.invalidMessageCount >= INVALID_MESSAGE_THRESHOLD) {
      const ttlMs =
        Math.pow(2, penalty.invalidMessageCount) *
        INVALID_MESSAGE_BLACKLIST_TTL;
      penalty.blacklistedExpiresAt = Date.now() + ttlMs;
      this.logger.warn(
        `Blacklisted host ${penaltyKey} for ${ttlMs}ms. Reason: ${reason}`,
      );
      for (const connection of this.connectionRegistry.getConnectedPeers()) {
        if (this.toPenaltyKey(connection.id) !== penaltyKey) {
          continue;
        }
        this.connectionRegistry.unregister(connection.id);
      }
    }

    const removedPeers = await this.pruneStalePeers();
    if (removedPeers > 0) {
      await this.save();
    }
  }

  get inboundConnectionCount(): number {
    return this.connectionRegistry.inboundCount;
  }

  get outboundConnectionCount(): number {
    return this.connectionRegistry.outboundCount;
  }

  canAcceptInbound(peerId?: string): boolean {
    if (peerId && !this.isHostAllowedToConnect(peerId)) {
      return false;
    }

    return this.connectionRegistry.canAcceptInbound();
    return (
      (peerId && !this.isHostAllowedToConnect(peerId)) ||
      this.connectionRegistry.canAcceptInbound()
    );
  }

  canAcceptOutbound(): boolean {
    return this.connectionRegistry.canAcceptOutbound();
  }

  get totalConnections(): number {
    return this.connectionRegistry.totalCount;
  }

  getConnectedPeers(peerId?: string): PeerConnection[] {
    return peerId
      ? this.connectionRegistry.getConnectedPeersExcept(peerId)
      : this.connectionRegistry.getConnectedPeers();
  }

  hasOutboundConnection(peerId: string): boolean {
    return this.connectionRegistry.hasOutbound(peerId);
  }

  getOutboundCandidates(): string[] {
    return this.getKnownPeers().filter((peer) => {
      if (this.hasOutboundConnection(peer) || !this.isAcceptablePeer(peer)) {
        return false;
      }

      return this.isHostAllowedToConnect(peer);
    });
  }

  broadcast(msg: ValidMessage, excludePeerId?: string): void {
    const peersToSend = this.getConnectedPeers(excludePeerId);

    for (const peer of peersToSend) {
      peer.send(msg);
    }
  }
}
