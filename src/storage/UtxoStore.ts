import type { UtxoKey, UtxoRows, UtxoSnapshot } from "@/protocol/types";
import { DEFAULT_DB_PATH } from "@/shared/constants";
import { Level } from "level";

export interface UtxoStoreInterface {
  key(txid: string, index: number): UtxoKey;
  empty(): UtxoSnapshot;
  clone(snapshot: UtxoSnapshot | null): UtxoSnapshot;
  hasAfterBlock(blockId: string): Promise<boolean>;
  getAfterBlock(blockId: string): Promise<UtxoSnapshot | null>;
  putAfterBlock(blockId: string, snapshot: UtxoSnapshot): Promise<void>;
}

class UtxoStore implements UtxoStoreInterface {
  private readonly db: Level<string, UtxoRows>;
  constructor(db?: Level<string, UtxoRows>) {
    this.db =
      db || new Level(`${DEFAULT_DB_PATH}/utxos`, { valueEncoding: "json" });
  }
  key(txid: string, index: number): UtxoKey {
    return `${txid}:${index}`;
  }

  empty(): UtxoSnapshot {
    return new Map();
  }
  clone(snapshot: UtxoSnapshot | null): UtxoSnapshot {
    return new Map(snapshot ?? []);
  }
  async hasAfterBlock(blockId: string): Promise<boolean> {
    return this.db.has(blockId);
  }
  async getAfterBlock(blockId: string): Promise<UtxoSnapshot | null> {
    try {
      const rows = (await this.db.get(blockId)) as UtxoRows;
      return new Map(
        rows.map((entry) => [this.key(entry.txid, entry.index), entry]),
      );
    } catch (err) {
      return null;
    }
  }
  async putAfterBlock(blockId: string, snapshot: UtxoSnapshot): Promise<void> {
    await this.db.put(blockId, [...snapshot.values()]);
  }
}

export default UtxoStore;
