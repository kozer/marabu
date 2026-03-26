import type { UtxoKey, UtxoRows, UtxoSnapshot } from "@/protocol/types";
import { DEFAULT_DB_PATH } from "@/shared/constants";
import { Level } from "level";

export interface UtxoStoreInterface {
  key(txid: string, index: number): UtxoKey;
  empty(): UtxoSnapshot;
  clone(snapshot: UtxoSnapshot | null): UtxoSnapshot;
  has(blockId: string): Promise<boolean>;
  get(blockId: string): Promise<UtxoSnapshot | null>;
  put(blockId: string, snapshot: UtxoSnapshot): Promise<void>;
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
  async has(blockId: string): Promise<boolean> {
    return this.db.has(blockId);
  }
  async get(blockId: string): Promise<UtxoSnapshot | null> {
    try {
      const rows = (await this.db.get(blockId)) as UtxoRows;
      if (rows === undefined) {
        return null;
      }
      return new Map(
        rows.map((entry) => [this.key(entry.txid, entry.index), entry]),
      );
    } catch (err) {
      return null;
    }
  }
  async put(blockId: string, snapshot: UtxoSnapshot): Promise<void> {
    await this.db.put(blockId, [...snapshot.values()]);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export default UtxoStore;
