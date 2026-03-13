import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Level } from "level";
import type { ObjectMessage } from "@/protocol/types";
import { DEFAULT_DB_PATH, FIND_TIMEOUT_MS } from "@/shared/constants";
import RequestQueue from "./requestQueue";

export interface ObjectManagerInterface {
  id(obj: unknown): string;
  exists(id: string): Promise<boolean>;
  get(id: string): Promise<ObjectMessage>;
  findObject(
    objectId: string,
    requestObject: (id: string) => void,
  ): Promise<ObjectMessage>;
}

class ObjectManager implements ObjectManagerInterface {
  private db: Level;
  pendingFinds: Map<
    string,
    {
      resolve: (value: ObjectMessage) => void;
      reject: (reason?: any) => void;
    }[]
  > = new Map();
  private requestQueue: RequestQueue = new RequestQueue();

  constructor(db?: Level) {
    this.db = db || new Level(DEFAULT_DB_PATH, { valueEncoding: "json" });
  }
  async get(id: string): Promise<ObjectMessage> {
    const object = await this.db.get(id);
    if (object === undefined) {
      throw new Error(`Object ${id} not found`);
    }
    return object as unknown as ObjectMessage;
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

    const waitPromise = new Promise<ObjectMessage>((resolve) => {
      const existing = this.pendingFinds.get(objectId);
      if (existing) {
        existing.push({ resolve, reject: () => {} });
      } else {
        this.pendingFinds.set(objectId, [{ resolve, reject: () => {} }]);
        this.requestQueue.add(objectId, requestObject);
      }
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        this.pendingFinds.delete(objectId);
        reject(new Error(`Timeout waiting for object ${objectId}`));
      }, FIND_TIMEOUT_MS);
    });

    return Promise.race([waitPromise, timeoutPromise]);
  }
}
export default ObjectManager;
