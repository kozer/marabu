import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Level } from "level";
import type { ChainState, ObjectData } from "@/protocol/types";
import { DEFAULT_DB_PATH, FIND_TIMEOUT_MS } from "@/shared/constants";
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
  put(object: ObjectData): Promise<string>;
  getChainState(): Promise<ChainState>;
  updateChainState(tipId: string, height: number): Promise<void>;
  getBlockHeight(blockId: string): Promise<number | null>;
  close(): Promise<void>;
}

class ObjectManager implements ObjectManagerInterface {
  private readonly db: Level;
  pendingFinds: Map<string, PendingWaiter[]> = new Map();
  private requestQueue: RequestQueue;
  private logger: pino.Logger;

  constructor(logger: pino.Logger, db?: Level) {
    this.db = db || new Level(`${DEFAULT_DB_PATH}/objects`, { valueEncoding: "json" });
    this.logger = logger;
    this.requestQueue = new RequestQueue(logger);
  }
  async getBlockHeight(blockId: string): Promise<number | null> {
    try {
      const h = await this.db.get(`height:${blockId}`);
      return parseInt(h, 10);
    } catch (err: any) {
      if (err.notFound) return null;
      throw err;
    }
  }
  async updateChainState(tip: string, height: number): Promise<void> {
    const batch = this.db.batch();
    batch.put(`height:${tip}`, height.toString());
    batch.put("meta:tip", tip);
    batch.put("meta:height", height.toString());
    await batch.write();
  }
  async getChainState(): Promise<ChainState> {
    // Use allSettled to prevent a single 'notFound' from rejecting the whole operation
    const [tipResult, heightResult] = await Promise.allSettled([
      this.db.get("meta:tip"),
      this.db.get("meta:height"),
    ]);

    // Extract values or use defaults if rejected (e.g., key not found)
    const tipId = tipResult.status === "fulfilled" ? (tipResult.value as string) : "";

    const height =
      heightResult.status === "fulfilled" ? parseInt(heightResult.value as string, 10) : 0;

    return {
      tip: tipId || "",
      height: isNaN(height) ? 0 : height,
    };
  }
  async get(id: string): Promise<ObjectData> {
    const object = await this.db.get(id);
    if (object === undefined) {
      throw new Error(`Object ${id} not found`);
    }
    return object as unknown as ObjectData;
  }

  async put(object: ObjectData): Promise<string> {
    const objectId = this.id(object);
    await this.db.put(objectId, object as any);

    const waiters = this.pendingFinds.get(objectId);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
        this.logger.info(`Resolving pending find for object ${objectId}`);
        waiter.resolve(object);
      }
      this.pendingFinds.delete(objectId);
    }

    return objectId;
  }

  id(obj: unknown): string {
    const canonical = canonicalize(obj);
    if (!canonical) {
      throw new Error("Failed to canonicalize object");
    }

    return bytesToHex(blake2s(Buffer.from(canonical, "utf8")));
  }

  async exists(id: string): Promise<boolean> {
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
