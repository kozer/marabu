import {
  BOOTSTRAP_PEERS,
  DIAL_FAILURE_BLACKLIST_BASE_TTL_MS,
  DIAL_FAILURE_BLACKLIST_THRESHOLD,
  INVALID_MESSAGE_BLACKLIST_BASE_TTL_MS,
  INVALID_MESSAGE_THRESHOLD,
  INVALID_SELF_HOSTS,
  MAX_PEERS_FROM_MESSAGE,
  MAX_PEERS_PER_SOURCE,
  SERVER_HOST,
  SERVER_PORT,
  STALE_FAILED_PEER_FAILURE_THRESHOLD,
  STALE_FAILED_PEER_MAX_AGE_MS,
  STALE_PEER_MAX_AGE_MS,
} from "@/shared/constants";
import { normalizePeer, parsePeerAddress } from "@/shared/utils";
import type { PeerStore } from "@/peers/peerStore";
import type { PeerConnection } from "@/net/peerConnection";
import { ConnectionRegistry } from "@/peers/connectionRegistry";
import ip from "ip";
import { isIP } from "node:net";
import type { ValidMessage } from "@/protocol/types";

type PeerRecord = {
  discoveredAt: number;
  introducedBy: Set<string>;
  failureCount: number;
  invalidMessageCount: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  blacklistedUntil?: number;
};

export class PeerManager {
  private knownPeers: Map<string, PeerRecord>;
  private persistedBlacklistedPeers: Set<string>;
  private readonly store: PeerStore;
  private readonly myNode = `${SERVER_HOST}:${SERVER_PORT}`;
  private readonly logger: any;
  private readonly connectionRegistry: ConnectionRegistry;

  private createPeerRecord(sourcePeerId?: string): PeerRecord {
    return {
      discoveredAt: Date.now(),
      introducedBy: sourcePeerId ? new Set([sourcePeerId]) : new Set(),
      failureCount: 0,
      invalidMessageCount: 0,
    };
  }

  private getPeerRecord(peer: string): PeerRecord | undefined {
    return this.knownPeers.get(peer);
  }

  private getOrCreatePeerRecord(
    peer: string,
    sourcePeerId?: string,
  ): PeerRecord {
    const existing = this.knownPeers.get(peer);
    if (existing) {
      if (sourcePeerId) {
        existing.introducedBy.add(sourcePeerId);
      }
      return existing;
    }

    const created = this.createPeerRecord(sourcePeerId);
    this.knownPeers.set(peer, created);
    return created;
  }

  private isBlacklisted(peer: string, now = Date.now()): boolean {
    const record = this.getPeerRecord(peer);
    if (!record?.blacklistedUntil) {
      return false;
    }

    if (record.blacklistedUntil <= now) {
      delete record.blacklistedUntil;
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

  private shouldPrunePeer(record: PeerRecord, now = Date.now()): boolean {
    if (record.lastSuccessAt) {
      return false;
    }

    const peerAge = now - record.discoveredAt;
    if (
      record.failureCount >= STALE_FAILED_PEER_FAILURE_THRESHOLD &&
      record.lastFailureAt !== undefined &&
      now - record.lastFailureAt >= STALE_FAILED_PEER_MAX_AGE_MS
    ) {
      return true;
    }

    return peerAge >= STALE_PEER_MAX_AGE_MS;
  }

  async pruneStalePeers(now = Date.now()): Promise<number> {
    let removed = 0;

    for (const [peer, record] of this.knownPeers.entries()) {
      if (!this.shouldPrunePeer(record, now)) {
        continue;
      }

      this.knownPeers.delete(peer);
      this.connectionRegistry.unregister(peer);
      removed += 1;
    }

    if (removed > 0) {
      this.logger.info(`Pruned ${removed} stale peer(s) from address book.`);
      await this.save();
    }

    return removed;
  }

  private canDial(peer: string, now = Date.now()): boolean {
    const record = this.getPeerRecord(peer);
    if (!record) {
      return true;
    }

    if (this.isBlacklisted(peer, now)) {
      return false;
    }

    if (!record.lastFailureAt || record.failureCount === 0) {
      return true;
    }

    const cooldown = Math.pow(2, record.failureCount) * 60 * 1000;
    return now - record.lastFailureAt >= cooldown;
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

  constructor(store: PeerStore, logger: any) {
    this.store = store;
    this.knownPeers = new Map();
    this.persistedBlacklistedPeers = new Set();
    this.logger = logger;
    this.connectionRegistry = new ConnectionRegistry(logger);
  }

  getKnownPeers(): string[] {
    return [...this.knownPeers.keys()];
  }

  getPeersForAdvertisement(): string[] {
    const peers = this.getKnownPeers().filter((peer) =>
      this.isAcceptablePeer(peer),
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
      this.logger.info(`My node address: ${this.myNode}`);
      this.persistedBlacklistedPeers = new Set(storedState.blacklistedPeers);

      if (storedPeers.length === 0) {
        this.knownPeers = new Map(
          BOOTSTRAP_PEERS.map((peer) => [peer, this.createPeerRecord()]),
        );
        await this.save();
      } else {
        this.knownPeers = new Map(
          storedPeers
            .filter((peer) => !this.persistedBlacklistedPeers.has(peer))
            .map((peer) => normalizePeer(peer))
            .filter((peer) => this.isAcceptablePeer(peer))
            .map((peer) => [peer, this.createPeerRecord()]),
        );
      }

      this.logger.info(`Loaded ${this.knownPeers.size} peers from storage.`);

      return this.getKnownPeers();
    } catch (err) {
      this.logger.error(err, "Failed to load peers from storage");
      this.persistedBlacklistedPeers = new Set();
      this.knownPeers = new Map(
        BOOTSTRAP_PEERS.map((peer) => [peer, this.createPeerRecord()]),
      );
      return this.getKnownPeers();
    }
  }

  async save(): Promise<void> {
    try {
      const peersToPersist = this.getKnownPeers();
      await this.store.save({
        peers: peersToPersist,
        blacklistedPeers: [...this.persistedBlacklistedPeers],
      });
      this.logger.info(`Saved ${peersToPersist.length} peers to storage.`);
    } catch (err) {
      this.logger.error(err, "Failed to save peers to storage");
    }
  }

  registerInboundConnection(connection: PeerConnection): void {
    //Inbound connections are just clients. No need to update peer records or check blacklisting here.
    this.connectionRegistry.registerInbound(connection);
  }

  registerOutboundConnection(connection: PeerConnection): void {
    const record = this.getOrCreatePeerRecord(connection.id);
    record.failureCount = 0;
    record.lastSuccessAt = Date.now();
    delete record.blacklistedUntil;

    this.connectionRegistry.registerOutbound(connection);
    this.logger.info(
      `Outbound peer connected: ${connection.id}. Active outbound peers: ${this.connectionRegistry.outboundCount}`,
    );
  }

  unregisterConnection(id: string): void {
    this.connectionRegistry.unregister(id);
  }

  async onDialFail(peer: string): Promise<void> {
    const record = this.getOrCreatePeerRecord(peer);
    record.failureCount += 1;
    record.lastFailureAt = Date.now();

    if (
      record.failureCount >= DIAL_FAILURE_BLACKLIST_THRESHOLD &&
      !record.lastSuccessAt
    ) {
      const ttlMs =
        Math.pow(2, record.failureCount) * DIAL_FAILURE_BLACKLIST_BASE_TTL_MS;
      this.blacklistPeer(peer, ttlMs, "Repeated dial failures");
    }

    await this.pruneStalePeers();
  }

  blacklistPeer(peer: string, ttlMs: number, reason: string): void {
    const record = this.getOrCreatePeerRecord(peer);
    record.blacklistedUntil = Date.now() + ttlMs;
    this.persistedBlacklistedPeers.add(peer);
    this.logger.warn(
      `Blacklisted peer ${peer} for ${ttlMs}ms. Reason: ${reason}`,
    );
    this.connectionRegistry.unregister(peer);
    void this.save();
  }

  async reportInvalidPeer(peer: string, reason: string): Promise<void> {
    const record = this.getOrCreatePeerRecord(peer);
    record.invalidMessageCount += 1;
    this.logger.warn(
      `Peer ${peer} sent invalid data (${record.invalidMessageCount}): ${reason}`,
    );

    if (record.invalidMessageCount >= INVALID_MESSAGE_THRESHOLD) {
      const ttlMs =
        Math.pow(2, record.invalidMessageCount) *
        INVALID_MESSAGE_BLACKLIST_BASE_TTL_MS;
      this.blacklistPeer(peer, ttlMs, reason);
    }

    await this.pruneStalePeers();
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

  hasOutboundConnection(peerId: string): boolean {
    return this.connectionRegistry.hasOutbound(peerId);
  }

  getOutboundCandidates(): string[] {
    return this.getKnownPeers().filter((peer) => {
      if (
        this.connectionRegistry.hasOutbound(peer) ||
        !this.isAcceptablePeer(peer)
      ) {
        return false;
      }

      return this.canDial(peer);
    });
  }

  broadcast(msg: ValidMessage, excludePeerId?: string): void {
    const peersToSend = excludePeerId
      ? this.getConnectedPeersExcept(excludePeerId)
      : this.getConnectedPeers();

    for (const peer of peersToSend) {
      peer.send(msg);
    }
  }
}
