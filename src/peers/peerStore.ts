export interface PeerStore {
  load(): Promise<{ peers: string[] }>;
  save(state: { peers: string[] }): Promise<void>;
}

export class FilePeerStore implements PeerStore {
  private file: ReturnType<typeof Bun.file>;

  constructor(filePath: string) {
    this.file = Bun.file(filePath);
  }

  async load(): Promise<{ peers: string[] }> {
    try {
      if (await this.file.exists()) {
        const data = await this.file.json();
        return {
          peers: data.peers || [],
        };
      }
    } catch (_) {}
    return { peers: [] };
  }

  async save(state: { peers: string[] }): Promise<void> {
    await Bun.write(this.file, JSON.stringify(state, null, 2));
  }
}

export class MemoryPeerStore implements PeerStore {
  private peers: string[] = [];

  async load(): Promise<{ peers: string[] }> {
    return {
      peers: [...this.peers],
    };
  }

  async save(state: { peers: string[] }): Promise<void> {
    this.peers = [...state.peers];
  }

  reset(): void {
    this.peers = [];
  }

  getPeers(): string[] {
    return [...this.peers];
  }
}
