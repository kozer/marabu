import { describe, expect, test } from "bun:test";
import ObjectManager from "@/storage/objectManager";
import {
  GENESIS_BLOCK,
  GENESIS_BLOCK_ID,
  MessageType,
  ObjectType,
  TARGET,
} from "@/protocol/types";
import type { ObjectData, ObjectMessage } from "@/protocol/types";
const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
};

function createObject(pubkey: string, value: number): ObjectMessage {
  return {
    type: MessageType.OBJECT,
    object: {
      type: ObjectType.TRANSACTION,
      outputs: [{ pubkey, value }],
    },
  };
}

function createManager(initialObjects: ObjectData[] = []) {
  const store = new Map<string, ObjectData>();
  const db = {
    get: async (id: string) => store.get(id),
    has: async (id: string) => store.has(id),
    put: async (id: string, object: ObjectData) => {
      store.set(id, object);
    },
  } as any;

  const manager = new ObjectManager(logger as any, db);

  for (const object of initialObjects) {
    store.set(manager.id(object), object);
  }

  return { manager, store };
}

function installTimerMocks() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let nextId = 1;

  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
    const id = nextId++;
    timers.set(id, () => {
      if (typeof handler === "function") {
        handler();
      }
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
    timers.delete(id as number);
  }) as typeof clearTimeout;

  return {
    pendingCount() {
      return timers.size;
    },
    runNext() {
      const next = timers.entries().next().value;
      if (!next) {
        throw new Error("No timer scheduled");
      }

      const [id, handler] = next;
      timers.delete(id);
      handler();
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

describe("ObjectManager", () => {
  test("computes the expected BLAKE2s id for the genesis block", () => {
    const manager = createManager().manager;

    expect(manager.id(GENESIS_BLOCK)).toBe(GENESIS_BLOCK_ID);
  });

  test("preserves the expected genesis target field", () => {
    expect(GENESIS_BLOCK.T).toBe(TARGET);
  });

  test("produces the same id regardless of object key order", () => {
    const manager = createManager().manager;

    const txA = {
      type: "transaction",
      inputs: [
        {
          outpoint: {
            txid: "11".repeat(32),
            index: 0,
          },
          sig: null,
        },
      ],
      outputs: [
        {
          pubkey: "22".repeat(32),
          value: 10,
        },
      ],
    } as any;

    const txB = {
      outputs: [
        {
          value: 10,
          pubkey: "22".repeat(32),
        },
      ],
      inputs: [
        {
          sig: null,
          outpoint: {
            index: 0,
            txid: "11".repeat(32),
          },
        },
      ],
      type: "transaction",
    } as any;

    expect(manager.id(txA)).toBe(manager.id(txB));
  });

  test("stores objects by computed id and reports existence", async () => {
    const object = createObject("33".repeat(32), 10);
    const { manager, store } = createManager();

    const objectId = await manager.put(object.object);

    expect(objectId).toBe(manager.id(object.object));
    expect(store.get(objectId)).toEqual(object.object);
    expect(manager.exists(objectId)).resolves.toBe(true);
  });

  test("returns stored objects with get", async () => {
    const object = createObject("44".repeat(32), 20);
    const { manager } = createManager([object.object]);
    const objectId = manager.id(object.object);

    expect(manager.get(objectId)).resolves.toEqual(object.object);
  });

  test("throws when get cannot find an object", async () => {
    const { manager } = createManager();
    const objectId = "ff".repeat(32);

    expect(manager.get(objectId)).rejects.toThrow(
      `Object ${objectId} not found`,
    );
  });

  test("returns immediately from findObject when the object already exists", async () => {
    const object = createObject("55".repeat(32), 30);
    const { manager } = createManager([object.object]);
    const objectId = manager.id(object.object);
    const requested: string[] = [];

    expect(
      await manager.findObject(objectId, (id) => requested.push(id)),
    ).toEqual(object.object);
    expect(requested).toEqual([]);
  });

  test("requests a missing object once and resolves when it is stored", async () => {
    const object = createObject("66".repeat(32), 40);
    const { manager } = createManager();
    const objectId = manager.id(object.object);
    const requested: string[] = [];
    let resolveRequest!: (id: string) => void;
    const requestSeen = new Promise<string>((resolve) => {
      resolveRequest = resolve;
    });

    const pending = manager.findObject(objectId, (id) => {
      requested.push(id);
      resolveRequest(id);
    });

    expect(requestSeen).resolves.toBe(objectId);

    expect(requested).toEqual([objectId]);

    await manager.put(object.object);

    expect(pending).resolves.toEqual(object.object);
    expect(manager.pendingFinds.has(objectId)).toBe(false);
  });

  test("coalesces concurrent callers waiting for the same missing object", async () => {
    const object = createObject("77".repeat(32), 50);
    const { manager } = createManager();
    const objectId = manager.id(object.object);
    const requested: string[] = [];
    let requestCount = 0;
    let resolveFirstRequest!: (id: string) => void;
    const firstRequestSeen = new Promise<string>((resolve) => {
      resolveFirstRequest = resolve;
    });

    const requestObject = (id: string) => {
      requestCount += 1;
      requested.push(id);
      if (requestCount === 1) {
        resolveFirstRequest(id);
      }
    };

    const firstPending = manager.findObject(objectId, requestObject);
    const secondPending = manager.findObject(objectId, requestObject);

    expect(firstRequestSeen).resolves.toBe(objectId);

    expect(requested).toEqual([objectId]);
    expect(requestCount).toBe(1);
    expect(manager.pendingFinds.get(objectId)).toHaveLength(2);

    await manager.put(object.object);

    expect(Promise.all([firstPending, secondPending])).resolves.toEqual([
      object.object,
      object.object,
    ]);
  });

  test("keeps later waiters alive when an earlier waiter times out", async () => {
    const timers = installTimerMocks();

    try {
      const object = createObject("88".repeat(32), 60);
      const { manager } = createManager();
      const objectId = manager.id(object.object);
      const requested: string[] = [];
      let requestCount = 0;
      let resolveFirstRequest!: (id: string) => void;
      const firstRequestSeen = new Promise<string>((resolve) => {
        resolveFirstRequest = resolve;
      });

      const requestObject = (id: string) => {
        requestCount += 1;
        requested.push(id);
        if (requestCount === 1) {
          resolveFirstRequest(id);
        }
      };

      const first = manager.findObject(objectId, requestObject).then(
        () => {
          throw new Error("Expected first waiter to time out");
        },
        (error) => error,
      );
      const second = manager.findObject(objectId, requestObject);

      expect(firstRequestSeen).resolves.toBe(objectId);

      expect(requested).toEqual([objectId]);
      expect(requestCount).toBe(1);
      expect(manager.pendingFinds.get(objectId)).toHaveLength(2);
      expect(timers.pendingCount()).toBe(2);

      timers.runNext();

      expect(first).resolves.toBeInstanceOf(Error);
      expect(manager.pendingFinds.get(objectId)).toHaveLength(1);
      expect(timers.pendingCount()).toBe(1);

      await manager.put(object.object);

      expect(second).resolves.toEqual(object.object);
      expect(manager.pendingFinds.has(objectId)).toBe(false);
      expect(timers.pendingCount()).toBe(0);
    } finally {
      timers.restore();
    }
  });

  test("throws when id cannot canonicalize unsupported data", () => {
    const manager = createManager().manager;

    expect(() => manager.id(undefined)).toThrow(
      "Failed to canonicalize object",
    );
  });
});
