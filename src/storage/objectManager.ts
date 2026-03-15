import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Level } from "level";
import type { ObjectMessage } from "@/protocol/types";
import { DEFAULT_DB_PATH, FIND_TIMEOUT_MS } from "@/shared/constants";
import RequestQueue from "./requestQueue";

export type PendingWaiter = {
  resolve: (value: ObjectMessage) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export interface ObjectManagerInterface {
  id(obj: unknown): string;
  exists(id: string): Promise<boolean>;
  get(id: string): Promise<ObjectMessage>;
  findObject(
    objectId: string,
    requestObject: (id: string) => void,
  ): Promise<ObjectMessage>;
  put(object: ObjectMessage): Promise<string>;
}

class ObjectManager implements ObjectManagerInterface {
  private readonly db: Level;
  pendingFinds: Map<string, PendingWaiter[]> = new Map();
  private requestQueue: RequestQueue = new RequestQueue();

  constructor(db?: Level) {
    this.db =
      db || new Level(`${DEFAULT_DB_PATH}/objects`, { valueEncoding: "json" });
  }
  async get(id: string): Promise<ObjectMessage> {
    const object = await this.db.get(id);
    if (object === undefined) {
      throw new Error(`Object ${id} not found`);
    }
    return object as unknown as ObjectMessage;
  }

  async put(object: ObjectMessage): Promise<string> {
    const objectId = this.id(object);
    await this.db.put(objectId, object as any);

    const waiters = this.pendingFinds.get(objectId);
    if (waiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId);
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

  async findObject(
    objectId: string,
    requestObject: (id: string) => void,
  ): Promise<ObjectMessage> {
    try {
      return await this.get(objectId);
    } catch {}

    const waiters = this.pendingFinds.get(objectId) ?? [];
    let waiter!: PendingWaiter;

    return new Promise<ObjectMessage>((resolve, reject) => {
      waiter = {
        resolve,
        timeoutId: setTimeout(() => {
          const current = this.pendingFinds.get(objectId) ?? [];
          const remaining = current.filter((w) => w !== waiter);
          if (remaining.length > 0) {
            this.pendingFinds.set(objectId, remaining);
          } else {
            this.pendingFinds.delete(objectId);
          }
          reject(new Error(`Timeout waiting for object ${objectId}`));
        }, FIND_TIMEOUT_MS),
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
