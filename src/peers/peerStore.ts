export interface PeerStore {
  load(): Promise<{ peers: string[]; blacklistedPeers: string[] }>;
  save(state: { peers: string[]; blacklistedPeers: string[] }): Promise<void>;
}

export class FilePeerStore implements PeerStore {
  private file: ReturnType<typeof Bun.file>;

  constructor(filePath: string) {
    this.file = Bun.file(filePath);
  }

  async load(): Promise<{ peers: string[]; blacklistedPeers: string[] }> {
    try {
      if (await this.file.exists()) {
        const data = await this.file.json();
        return {
          peers: data.peers || [],
          blacklistedPeers: data.blacklistedPeers || [],
        };
      }
    } catch (_) {}
    return { peers: [], blacklistedPeers: [] };
  }

  async save(state: {
    peers: string[];
    blacklistedPeers: string[];
  }): Promise<void> {
    await Bun.write(this.file, JSON.stringify(state, null, 2));
  }
}

export class MemoryPeerStore implements PeerStore {
  private peers: string[] = [];
  private blacklistedPeers: string[] = [];

  async load(): Promise<{ peers: string[]; blacklistedPeers: string[] }> {
    return {
      peers: [...this.peers],
      blacklistedPeers: [...this.blacklistedPeers],
    };
  }

  async save(state: {
    peers: string[];
    blacklistedPeers: string[];
  }): Promise<void> {
    this.peers = [...state.peers];
    this.blacklistedPeers = [...state.blacklistedPeers];
  }

  reset(): void {
    this.peers = [];
    this.blacklistedPeers = [];
  }

  getPeers(): string[] {
    return [...this.peers];
  }

  getBlacklistedPeers(): string[] {
    return [...this.blacklistedPeers];
  }
}
