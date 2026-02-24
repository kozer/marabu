export interface PeerStore {
  load(): Promise<string[]>;
  save(peers: string[]): Promise<void>;
}

export class FilePeerStore implements PeerStore {
  private file: ReturnType<typeof Bun.file>;

  constructor(filePath: string) {
    this.file = Bun.file(filePath);
  }

  async load(): Promise<string[]> {
    try {
      if (await this.file.exists()) {
        const data = await this.file.json();
        return data.peers || [];
      }
    } catch (_) {}
    return [];
  }

  async save(peers: string[]): Promise<void> {
    await Bun.write(this.file, JSON.stringify({ peers }, null, 2));
  }
}

export class MemoryPeerStore implements PeerStore {
  private peers: string[] = [];

  async load(): Promise<string[]> {
    return [...this.peers];
  }

  async save(peers: string[]): Promise<void> {
    this.peers = [...peers];
  }

  reset(): void {
    this.peers = [];
  }

  getPeers(): string[] {
    return [...this.peers];
  }
}
