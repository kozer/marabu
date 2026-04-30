import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Level } from "level";
import type { ChainState, ObjectData } from "@/protocol/types";
import { DEFAULT_DB_PATH, FIND_TIMEOUT_MS } from "@/shared/constants";
import LRUCache from "@/shared/lruCache";
import RequestQueue from "./requestQueue";
import type pino from "pino";

export type PendingWaiter = {
  resolve: (value: ObjectData) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export interface ObjectManagerInterface {
  id(obj: unknown): string;
  exists(id: string): Promise<boolean>;
  get(id: string): Promise<ObjectData>;
  findObject(
    objectId: string,
    requestObject: (id: string) => void,
    timeout?: number,
  ): Promise<ObjectData>;
  put(object: ObjectData, height?: number): Promise<string>;
  getChainState(): Promise<ChainState>;
  putChainState(blockId: string, height: number): Promise<void>;
  getBlockHeight(blockId: string): Promise<number | null>;
  delete(obj: ObjectData, height?: number): Promise<void>;
  resolvePending(objectId: string, object: ObjectData): void;
  close(): Promise<void>;
}

class ObjectManager implements ObjectManagerInterface {
  private readonly db: Level;
  pendingFinds: Map<string, PendingWaiter[]> = new Map();
  private requestQueue: RequestQueue;
  private logger: pino.Logger;
  private objectCache: LRUCache;
  private heightCache: Map<string, number> = new Map();
  private chainStateCache: ChainState | null = null;

  constructor(logger: pino.Logger, db?: Level) {
    this.db = db || new Level(`${DEFAULT_DB_PATH}/objects`, { valueEncoding: "json" });
    this.logger = logger;
    this.requestQueue = new RequestQueue(logger);
    this.objectCache = new LRUCache(10000);
  }
  async getBlockHeight(blockId: string): Promise<number | null> {
    const cached = this.heightCache.get(blockId);
    if (cached !== undefined) return cached === -1 ? null : cached;

    try {
      const h = await this.db.get(`height:${blockId}`);
      const result = parseInt(h, 10);
      if (isNaN(result)) {
        this.logger.warn(`Invalid height value for block ${blockId}: ${h}`);
        this.heightCache.set(blockId, -1);
        return null;
      }
      this.heightCache.set(blockId, result);
      return result;
    } catch (err: any) {
      if (err.notFound) {
        this.heightCache.set(blockId, -1);
        return null;
      }
      throw err;
    }
  }
  async putChainState(blockId: string, height: number): Promise<void> {
    const batch = this.db.batch();
    batch.put("meta:tip", blockId);
    batch.put("meta:height", height.toString());
    await batch.write();
    this.chainStateCache = { tip: blockId, height };
  }
  async getChainState(): Promise<ChainState> {
    if (this.chainStateCache) return this.chainStateCache;

    const [tipResult, heightResult] = await Promise.allSettled([
      this.db.get("meta:tip"),
      this.db.get("meta:height"),
    ]);

    const tipId = tipResult.status === "fulfilled" ? (tipResult.value as string) : "";
    const height =
      heightResult.status === "fulfilled" ? parseInt(heightResult.value as string, 10) : -1;

    this.chainStateCache = {
      tip: tipId || "",
      height: isNaN(height) ? -1 : height,
    };
    return this.chainStateCache;
  }
  async get(id: string): Promise<ObjectData> {
    if (this.objectCache.has(id)) {
      return this.objectCache.get(id) as ObjectData;
    }
    const object = await this.db.get(id);
    if (object === undefined) {
      throw new Error(`Object ${id} not found`);
    }
    const obj = object as unknown as ObjectData;
    this.objectCache.put(id, obj);
    return obj;
  }

  resolvePending(objectId: string, object: ObjectData) {
    const waiters = this.pendingFinds.get(objectId);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
        this.logger.info(`Resolving pending find for object ${objectId}`);
        waiter.resolve(object);
      }
      this.pendingFinds.delete(objectId);
    }
  }

  async put(object: ObjectData, height?: number): Promise<string> {
    const objectId = this.id(object);

    const batch = this.db.batch();
    batch.put(objectId, object as any);
    if (height !== undefined && object.type === "block") {
      batch.put(`height:${objectId}`, height.toString());
      this.heightCache.set(objectId, height);
    }
    await batch.write();
    this.objectCache.put(objectId, object);
    this.resolvePending(objectId, object);

    return objectId;
  }
  async delete(obj: ObjectData, height?: number): Promise<void> {
    const batch = this.db.batch();
    const objectId = this.id(obj);
    batch.del(objectId);
    if (height !== undefined && obj.type === "block") {
      batch.del(`height:${objectId}`);
    }
    await batch.write();
  }

  id(obj: unknown): string {
    const canonical = canonicalize(obj);
    if (!canonical) {
      throw new Error("Failed to canonicalize object");
    }

    return bytesToHex(blake2s(Buffer.from(canonical, "utf8")));
  }

  async exists(id: string): Promise<boolean> {
    if (this.objectCache.has(id)) return true;
    return await this.db.has(id);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async findObject(
    objectId: string,
    requestObject: (id: string) => void,
    timeout = FIND_TIMEOUT_MS,
  ): Promise<ObjectData> {
    try {
      return await this.get(objectId);
    } catch {}

    const waiters = this.pendingFinds.get(objectId) ?? [];
    let waiter!: PendingWaiter;

    return new Promise<ObjectData>((resolve, reject) => {
      waiter = {
        resolve: (value) => {
          resolve(value);
        },
        timeoutId: setTimeout(() => {
          const current = this.pendingFinds.get(objectId) ?? [];
          const remaining = current.filter((w) => w !== waiter);
          if (remaining.length > 0) {
            this.pendingFinds.set(objectId, remaining);
          } else {
            this.pendingFinds.delete(objectId);
          }
          reject(new Error(`Timeout waiting for object ${objectId}`));
        }, timeout),
      };

      if (waiters.length === 0) {
        this.pendingFinds.set(objectId, [waiter]);
        this.requestQueue.add(objectId, requestObject);
      } else {
        waiters.push(waiter);
        this.pendingFinds.set(objectId, waiters);
      }
    });
  }
}
export default ObjectManager;
