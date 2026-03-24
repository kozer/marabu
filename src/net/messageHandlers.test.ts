import { describe, expect, test } from "bun:test";
import {
  getObjectHandler,
  iHaveObjectHandler,
  objectHandler,
} from "@/net/messageHandlers";
import { SEPARATOR } from "@/shared/constants";
import {
  MessageType,
  ObjectType,
  type ConnectedPeerContext,
  type TransactionMessage,
} from "@/protocol/types";
import type {
  GetObjectMessage,
  IHaveObjectMessage,
  ObjectData,
  ObjectMessage,
  ValidMessage,
} from "@/protocol/types";
import ObjectManager from "@/storage/objectManager";
import {
  createTestPrivateKey,
  getPublicKeyHex,
  signTransaction,
} from "@/test/transactionTestUtils";

const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
};

function createInMemoryObjectManager(initialObjects: ObjectData[] = []) {
  const store = new Map<string, ObjectData>();
  const db = {
    get: async (id: string) => store.get(id),
    has: async (id: string) => store.has(id),
    put: async (id: string, object: ObjectData) => {
      store.set(id, object);
    },
  } as any;

  const manager = new ObjectManager(db);

  for (const object of initialObjects) {
    store.set(manager.id(object), object);
  }

  return { manager, store };
}

function createSocketMock() {
  const writes: string[] = [];
  return {
    socket: {
      write: (payload: string) => {
        writes.push(payload);
        return true;
      },
    } as any,
    writes,
  };
}

function parseSentMessages(writes: string[]): any[] {
  return writes.flatMap((payload) =>
    payload
      .split(SEPARATOR)
      .filter((message) => message.trim().length > 0)
      .map((message) => JSON.parse(message)),
  );
}

function createContext(args?: {
  id?: string;
  objectManager?: ConnectedPeerContext["objectManager"];
  socket?: ConnectedPeerContext["socket"];
  peerManager?: Partial<ConnectedPeerContext["peerManager"]>;
}) {
  const broadcasts: Array<{ message: ValidMessage; excludePeerId?: string }> =
    [];
  const peerManager = {
    broadcast: (message: ValidMessage, excludePeerId?: string) => {
      broadcasts.push({ message, excludePeerId });
    },
    getPeersForAdvertisement: () => [],
    getKnownPeerSet: () => new Set<string>(),
    addKnownPeers: async () => {},
    ...(args?.peerManager ?? {}),
  } as any;

  const ctx = {
    id: args?.id ?? "peer-1",
    socket: args?.socket ?? createSocketMock().socket,
    peerManager,
    logger,
    objectManager: args?.objectManager as any,
    blockManager: {
      getUtxoSet: async () => null,
      getBlock: async () => null,
      getBlockTransactions: async () => [],
      storeValidatedBlock: async () => {},
    },
  } as ConnectedPeerContext;

  return { ctx, broadcasts };
}

async function createValidRegularTransaction(manager: ObjectManager) {
  const privateKey = createTestPrivateKey();
  const senderPubkey = await getPublicKeyHex(privateKey);
  const previousTx: TransactionMessage = {
    type: ObjectType.TRANSACTION,
    height: 0,
    outputs: [{ pubkey: senderPubkey, value: 50 }],
  };

  await manager.put(previousTx);
  const previousTxId = manager.id(previousTx);

  const tx: TransactionMessage = {
    type: ObjectType.TRANSACTION,
    inputs: [
      {
        outpoint: {
          txid: previousTxId,
          index: 0,
        },
        sig: null,
      },
    ],
    outputs: [{ pubkey: "22".repeat(32), value: 10 }],
  };

  tx.inputs![0]!.sig = await signTransaction(tx, privateKey);

  return { previousTx, tx };
}

describe("messageHandlers object exchange", () => {
  test("requests unknown objects when receiving ihaveobject", async () => {
    const { manager } = createInMemoryObjectManager();
    const { socket, writes } = createSocketMock();
    const { ctx } = createContext({ objectManager: manager, socket });
    const message: IHaveObjectMessage = {
      type: MessageType.IHAVEOBJECT,
      objectid: "aa".repeat(32),
    };

    await iHaveObjectHandler(message, ctx);

    expect(parseSentMessages(writes)).toEqual([
      {
        type: MessageType.GET_OBJECT,
        objectid: message.objectid,
      },
    ]);
  });

  test("does not request known objects when receiving ihaveobject", async () => {
    const knownObject: ObjectData = {
      type: ObjectType.BLOCK,
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771159355,
      miner: "Marabu",
      nonce: "00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347",
      previd: null,
      txids: [],
    };
    const { manager } = createInMemoryObjectManager([knownObject]);
    const { socket, writes } = createSocketMock();
    const { ctx } = createContext({ objectManager: manager, socket });

    await iHaveObjectHandler(
      {
        type: MessageType.IHAVEOBJECT,
        objectid: manager.id(knownObject),
      },
      ctx,
    );

    expect(parseSentMessages(writes)).toEqual([]);
  });

  test("returns a stored object when receiving getobject", async () => {
    const object: ObjectData = {
      type: ObjectType.BLOCK,
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771159355,
      miner: "Marabu",
      nonce: "00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347",
      previd: null,
      txids: [],
    };
    const { manager } = createInMemoryObjectManager([object]);
    const { socket, writes } = createSocketMock();
    const { ctx } = createContext({ objectManager: manager, socket });
    const message: GetObjectMessage = {
      type: MessageType.GET_OBJECT,
      objectid: manager.id(object),
    };

    await getObjectHandler(message, ctx);

    expect(parseSentMessages(writes)).toEqual([
      {
        type: MessageType.OBJECT,
        object,
      },
    ]);
  });

  test("does not crash or send data when getobject misses", async () => {
    const { manager } = createInMemoryObjectManager();
    const { socket, writes } = createSocketMock();
    const { ctx } = createContext({ objectManager: manager, socket });

    await getObjectHandler(
      {
        type: MessageType.GET_OBJECT,
        objectid: "ff".repeat(32),
      },
      ctx,
    );

    expect(parseSentMessages(writes)).toEqual([]);
  });

  test("stores a new valid transaction and gossips its object id", async () => {
    const { manager } = createInMemoryObjectManager();
    const { socket, writes } = createSocketMock();
    const { ctx, broadcasts } = createContext({
      id: "peer-1",
      objectManager: manager,
      socket,
    });
    const { tx } = await createValidRegularTransaction(manager);
    const message: ObjectMessage = {
      type: MessageType.OBJECT,
      object: tx,
    };
    const objectId = manager.id(tx);

    await objectHandler(message, ctx);

    expect(await manager.get(objectId)).toEqual(tx);
    expect(parseSentMessages(writes)).toEqual([]);
    expect(broadcasts).toEqual([
      {
        message: {
          type: MessageType.IHAVEOBJECT,
          objectid: objectId,
        },
        excludePeerId: "peer-1",
      },
    ]);
  });

  test("serves a newly stored object to another peer", async () => {
    const { manager } = createInMemoryObjectManager();
    const senderSocket = createSocketMock();
    const receiverSocket = createSocketMock();
    const sender = createContext({
      id: "grader-1",
      objectManager: manager,
      socket: senderSocket.socket,
    });
    const receiver = createContext({
      id: "grader-2",
      objectManager: manager,
      socket: receiverSocket.socket,
    });
    const { tx } = await createValidRegularTransaction(manager);
    const objectId = manager.id(tx);

    await objectHandler(
      {
        type: MessageType.OBJECT,
        object: tx,
      },
      sender.ctx,
    );

    await getObjectHandler(
      {
        type: MessageType.GET_OBJECT,
        objectid: objectId,
      },
      receiver.ctx,
    );

    expect(parseSentMessages(receiverSocket.writes)).toEqual([
      {
        type: MessageType.OBJECT,
        object: tx,
      },
    ]);
  });

  test("ignores duplicate objects without re-gossiping", async () => {
    const { manager, store } = createInMemoryObjectManager();
    const { ctx, broadcasts } = createContext({ objectManager: manager });
    const { tx } = await createValidRegularTransaction(manager);
    const message: ObjectMessage = {
      type: MessageType.OBJECT,
      object: tx,
    };

    await objectHandler(message, ctx);
    expect(store.size).toBe(2);
    expect(broadcasts).toHaveLength(1);

    await objectHandler(message, ctx);

    expect(store.size).toBe(2);
    expect(broadcasts).toHaveLength(1);
  });

  test("sends an error and avoids gossiping invalid transactions", async () => {
    const { manager } = createInMemoryObjectManager();
    const { socket, writes } = createSocketMock();
    const { ctx, broadcasts } = createContext({
      objectManager: manager,
      socket,
    });
    const invalidTx: TransactionMessage = {
      type: ObjectType.TRANSACTION,
      inputs: [
        {
          outpoint: {
            txid: "11".repeat(32),
            index: 0,
          },
          sig: "00".repeat(64),
        },
      ],
      outputs: [{ pubkey: "22".repeat(32), value: 10 }],
    };
    const invalidTxId = manager.id(invalidTx);

    await objectHandler(
      {
        type: MessageType.OBJECT,
        object: invalidTx,
      },
      ctx,
    );

    expect(parseSentMessages(writes)).toEqual([
      {
        type: MessageType.ERROR,
        name: "UNKNOWN_OBJECT",
        description: "Cannot find one or more previous transactions",
      },
    ]);
    await expect(manager.get(invalidTxId)).rejects.toThrow(
      `Object ${invalidTxId} not found`,
    );
    expect(broadcasts).toEqual([]);
  });
});
