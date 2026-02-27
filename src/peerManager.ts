import {
  BOOTSTRAP_PEERS,
  INVALID_SELF_HOSTS,
  MAX_PEERS,
  OUTBOUND_PEER_LIMIT,
  SERVER_HOST,
  SERVER_PORT,
} from "./constants";
import { normalizePeer, parseHost } from "./utils";
import type { PeerStore } from "./peerStore";
import ip from "ip";
import { isIP } from "node:net";

export class PeerManager {
  private readonly MAX_PEERS = MAX_PEERS;
  private peerAddressBook: Set<string>;
  inboundConnections = new Set<string>();
  outboundConnections = new Set<string>();
  private failedAttempts = new Map<string, number>();
  private lastAttempt = new Map<string, number>();
  private readonly store: PeerStore;
  private readonly myNode = `${SERVER_HOST}:${SERVER_PORT}`;
  private readonly logger: any;

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
    this.peerAddressBook = new Set(BOOTSTRAP_PEERS);
    this.logger = logger;
  }

  has(peer: string): boolean {
    return this.peerAddressBook.has(peer);
  }

  getAll(): string[] {
    return [...this.peerAddressBook];
  }

  getPeers(): Set<string> {
    return this.peerAddressBook;
  }

  async add(peer: string): Promise<void> {
    const normalizedPeer = normalizePeer(peer);
    if (
      !this.peerAddressBook.has(normalizedPeer) &&
      this.isValidPeer(normalizedPeer)
    ) {
      this.peerAddressBook.add(normalizedPeer);
      this.logger.info(`Added new peer: ${normalizedPeer}`);
      await this.save();
    }
  }

  async addAll(peers: string[]): Promise<void> {
    const newPeers = [];
    for (const peer of peers) {
      const normalizedPeer = normalizePeer(peer);
      if (
        !this.peerAddressBook.has(normalizedPeer) &&
        this.isValidPeer(normalizedPeer)
      ) {
        newPeers.push(normalizedPeer);
        this.peerAddressBook.add(normalizedPeer);
      }
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
      const combinedPeers = [...BOOTSTRAP_PEERS, ...storedPeers, this.myNode];
      this.logger.info(`My node address: ${this.myNode}`);
      this.peerAddressBook = new Set(combinedPeers);
      this.logger.info(
        `Loaded ${this.peerAddressBook.size} peers from storage.`,
      );

      return this.getAll();
    } catch (err) {
      this.logger.error(err, "Failed to load peers from storage");
      this.peerAddressBook = new Set([...BOOTSTRAP_PEERS, this.myNode]);
      return this.getAll();
    }
  }

  async save(): Promise<void> {
    try {
      const peersArray = this.getAll();
      await this.store.save(peersArray);
      this.logger.info(`Saved ${peersArray.length} peers to storage.`);
    } catch (err) {
      this.logger.error(err, "Failed to save peers to storage");
    }
  }

  onConnectionOpen(id: string): void {
    this.inboundConnections.add(id);
    this.logger.info(
      `Peer connected: ${id}. Active peers: ${this.inboundConnections.size}`,
    );
  }

  onConnectionClose(id: string): void {
    this.inboundConnections.delete(id);
    this.logger.info(
      `Peer disconnected: ${id}. Active peers: ${this.inboundConnections.size}`,
    );
  }

  canAcceptInbound(): boolean {
    return this.inboundConnections.size < this.MAX_PEERS - OUTBOUND_PEER_LIMIT;
  }

  canAcceptOutbound(): boolean {
    return this.outboundConnections.size < OUTBOUND_PEER_LIMIT;
  }

  get totalConnections(): number {
    return this.inboundConnections.size + this.outboundConnections.size;
  }

  onDialFail(peer: string) {
    const attempts = (this.failedAttempts.get(peer) || 0) + 1;
    this.failedAttempts.set(peer, attempts);
    this.lastAttempt.set(peer, Date.now());
    this.outboundConnections.delete(peer);

    this.logger.debug(`Peer ${peer} failed. Total attempts: ${attempts}`);
  }

  onDialSuccess(peer: string) {
    this.failedAttempts.delete(peer);
    this.lastAttempt.set(peer, Date.now());
    this.outboundConnections.add(peer);
  }

  getOutboundCandidates(): string[] {
    const now = Date.now();

    return this.getAll().filter((peer) => {
      if (
        this.inboundConnections.has(peer) ||
        this.outboundConnections.has(peer) ||
        !this.isValidPeer(peer)
      ) {
        return false;
      }

      const failures = this.failedAttempts.get(peer) || 0;
      const lastTime = this.lastAttempt.get(peer) || 0;

      if (failures > 0) {
        //Exponential backoff: 1 min after 1 failure, 2 min after 2 failures etc
        const cooldown = Math.pow(2, failures) * 60 * 1000;
        if (now - lastTime < cooldown) return false;
      }

      return true;
    });
  }
}
