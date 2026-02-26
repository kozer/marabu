import {
  BOOTSTRAP_PEERS,
  MAX_PEERS,
  OUTBOUND_PEER_LIMIT,
  SERVER_HOST,
  SERVER_PORT,
} from "./constants";
import { parseHost } from "./utils";
import type { PeerStore } from "./peerStore";

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
    if (peer === this.myNode) {
      return false;
    }
    const { host, port } = parseHost(peer) || {};
    if (!host || !port) return false;

    if (isNaN(port) || port <= 0 || port > 65535) return false;
    const lowercaseHost = host.toLowerCase();
    if (
      lowercaseHost === "localhost" ||
      lowercaseHost === "loopback" ||
      lowercaseHost === "[::1]" // IPv6 Localhost
    ) {
      return false;
    }

    if (
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.")
    ) {
      return false;
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
    if (!this.peerAddressBook.has(peer)) {
      this.peerAddressBook.add(peer);
      this.logger.info(`Added new peer: ${peer}`);
      await this.save();
    }
  }

  async addAll(peers: string[]): Promise<void> {
    const newPeers = [];
    for (const peer of peers) {
      if (!this.peerAddressBook.has(peer)) {
        newPeers.push(peer);
        this.peerAddressBook.add(peer);
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
