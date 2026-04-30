import type { UtxoEntry, UtxoKey, UtxoRow, UtxoSnapshot } from "@/protocol/types";
import { DEFAULT_DB_PATH } from "@/shared/constants";
import LRUCache from "@/shared/lruCache";
import { Level } from "level";
import type pino from "pino";

export interface UtxoStoreInterface {
  key(txid: string, index: number): UtxoKey;
  empty(): UtxoSnapshot;
  clone(snapshot: UtxoSnapshot | null): UtxoSnapshot;
  has(blockId: string): Promise<boolean>;
  get(blockId: string): Promise<UtxoSnapshot | null>;
  put(blockId: string, snapshot: UtxoSnapshot): Promise<void>;
  delete(blockId: string): Promise<void>;
}

class UtxoStore implements UtxoStoreInterface {
  private readonly db: Level<string, UtxoRow>;
  private readonly logger: pino.Logger;
  private cache: LRUCache;

  constructor(logger: pino.Logger, db?: Level<string, UtxoRow>) {
    this.db = db || new Level(`${DEFAULT_DB_PATH}/utxos`, { valueEncoding: "json" });
    this.logger = logger;
    this.cache = new LRUCache(100);
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
    if (this.cache.has(blockId)) return true;
    return this.db.has(blockId);
  }
  async delete(blockId: string): Promise<void> {
    const prefix = `block:${blockId}:utxo:`;
    const batch = this.db.batch();
    batch.del(`status:${blockId}`);
    for await (const [key] of this.db.iterator({
      gt: prefix,
      lt: prefix + "\xff",
    })) {
      batch.del(key);
    }
    await batch.write();
  }
  async get(blockId: string): Promise<UtxoSnapshot | null> {
    if (this.cache.has(blockId)) {
      const cached = this.cache.get(blockId) as UtxoSnapshot | null;
      // Return a clone so mutations don't affect the cached copy
      return cached ? this.clone(cached) : null;
    }

    const snapshot: UtxoSnapshot = new Map();
    const prefix = `block:${blockId}:utxo:`;

    try {
      if (!(await this.db.has(`status:${blockId}`))) {
        this.cache.put(blockId, null);
        return null;
      }

      for await (const [_key, value] of this.db.iterator({
        gt: prefix,
        lt: prefix + "\xff",
      })) {
        const entry = value as UtxoEntry;
        snapshot.set(this.key(entry.txid, entry.index), entry);
      }

      this.cache.put(blockId, snapshot);
      return this.clone(snapshot);
    } catch (err) {
      this.logger.error(`Failed to stream UTXOs for ${blockId}: ${err}`);
      return null;
    }
  }
  async put(blockId: string, snapshot: UtxoSnapshot): Promise<void> {
    const batch = this.db.batch();

    batch.put(`status:${blockId}`, "valid");

    for (const [utxoKey, entry] of snapshot) {
      const dbKey = `block:${blockId}:utxo:${utxoKey}`;
      batch.put(dbKey, entry);
    }

    await batch.write();
    this.cache.put(blockId, this.clone(snapshot));
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export default UtxoStore;
