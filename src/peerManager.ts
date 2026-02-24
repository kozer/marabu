import {
  BOOTSTRAP_PEERS,
  MAX_PEERS,
  PEERS_FILE,
  SERVER_HOST,
  SERVER_PORT,
} from "./constants";
import logger from "./logger";
import { parseHost } from "./utils";

export class PeerManager {
  private readonly MAX_PEERS = MAX_PEERS;
  private peerAddressBook: Set<string>;
  activeConnections = new Set<string>();
  private failedAttempts = new Map<string, number>();
  private lastAttempt = new Map<string, number>();
  private readonly file = Bun.file(PEERS_FILE);
  private readonly myNode = `${SERVER_HOST}:${SERVER_PORT}`;

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

  constructor() {
    this.peerAddressBook = new Set(BOOTSTRAP_PEERS);
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
      logger.info(`Added new peer: ${peer}`);
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
      logger.info(
        `Added ${newPeers.length} new peer(s): ${newPeers.join(", ")}`,
      );
      await this.save();
    }
  }

  async load(): Promise<string[]> {
    try {
      if (await this.file.exists()) {
        const data = await this.file.json();
        const combinedPeers = [...BOOTSTRAP_PEERS, ...data.peers, this.myNode];
        logger.info(`My node address: ${this.myNode}`);
        this.peerAddressBook = new Set(combinedPeers);
        logger.info(`Loaded ${this.peerAddressBook.size} peers from disk.`);

        return this.getAll();
      }
    } catch (err) {
      logger.error(err, "Failed to load peers from disk");
    }

    this.peerAddressBook = new Set([...BOOTSTRAP_PEERS, this.myNode]);
    return this.getAll();
  }

  async save(): Promise<void> {
    try {
      const peersArray = this.getAll();
      await Bun.write(
        this.file,
        JSON.stringify({ peers: peersArray }, null, 2),
      );
      logger.info(`Saved ${peersArray.length} peers to disk.`);
    } catch (err) {
      logger.error(err, "Failed to save peers to disk");
    }
  }

  onConnectionOpen(id: string): void {
    this.activeConnections.add(id);
    logger.info(
      `Peer connected: ${id}. Active peers: ${this.activeConnections.size}`,
    );
  }

  onConnectionClose(id: string): void {
    this.activeConnections.delete(id);
    logger.info(
      `Peer disconnected: ${id}. Active peers: ${this.activeConnections.size}`,
    );
  }

  canAcceptConnection(): boolean {
    return this.activeConnections.size < this.MAX_PEERS;
  }
  get slotsAvailable(): number {
    return this.MAX_PEERS - this.activeConnections.size;
  }
  onDialFail(peer: string) {
    const attempts = (this.failedAttempts.get(peer) || 0) + 1;
    this.failedAttempts.set(peer, attempts);
    this.lastAttempt.set(peer, Date.now());

    logger.debug(`Peer ${peer} failed. Total attempts: ${attempts}`);
  }

  // Call this when a connection succeeds
  onDialSuccess(peer: string) {
    this.failedAttempts.delete(peer);
    this.lastAttempt.set(peer, Date.now());
  }

  getOutboundCandidates(): string[] {
    const now = Date.now();

    return this.getAll().filter((peer) => {
      if (this.activeConnections.has(peer)) return false;

      if (!this.isValidPeer(peer)) return false;

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
