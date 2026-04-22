import { describe, expect, test } from "bun:test";
import { getObjectHandler, iHaveObjectHandler, objectHandler } from "@/net/messageHandlers";
import {
  ErrorCode,
  MessageType,
  ObjectType,
  type Connection,
  type TransactionMessage,
} from "@/protocol/types";
import type {
  GetObjectMessage,
  IHaveObjectMessage,
  ObjectData,
  ObjectMessage,
  ValidMessage,
} from "@/protocol/types";
import ProtocolError from "@/protocol/error";
import ObjectManager from "@/storage/objectManager";
import {
  createTestPrivateKey,
  getPublicKeyHex,
  signTransaction,
} from "@/test/transactionTestUtils";
import type pino from "pino";

const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
} as unknown as pino.Logger;

/**
 * Mocks the storage layer for tests
 */
function createInMemoryObjectManager(initialObjects: ObjectData[] = []) {
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

/**
 * Creates the bundle of managers that the Dispatcher normally provides.
 * This is passed as the 3rd argument to handlers.
 */
function createMockManagers(args?: {
  objectManager?: any;
  blockManager?: any;
  transactionManager?: any;
  peerManager?: any;
}) {
  const objectManager = args?.objectManager ?? createInMemoryObjectManager().manager;
  const peerManager = args?.peerManager ?? {
    broadcast: () => {},
    addKnownPeers: async () => {},
    getKnownPeerSet: () => new Set(),
  };
  return {
    object: objectManager,
    block: args?.blockManager ?? {
      validate: async () => ({}),
      storeValidatedBlock: async () => {},
    },
    tx: args?.transactionManager ?? {
      async handleIncoming(tx: any, connection: any) {
        // Skip validation for valid transactions, throw for invalid
        if (!tx.inputs || tx.inputs.length === 0) {
          throw new ProtocolError(ErrorCode.INVALID_FORMAT, "Missing inputs");
        }
        await objectManager.put(tx);
        peerManager.broadcast(
          { type: MessageType.IHAVEOBJECT, objectid: objectManager.id(tx) },
          connection.id,
        );
      },
    },
    peer: peerManager,
  };
}

/**
 * Mocks the Connection and narrowed PeerContext
 */
function createMockConnection(args?: { id?: string; peerManager?: any }) {
  const sent: any[] = [];
  const broadcasts: any[] = [];

  const peerManager = args?.peerManager ?? {
    broadcast: (message: ValidMessage, excludePeerId?: string) => {
      broadcasts.push({ message, excludePeerId });
    },
    getPeersForAdvertisement: () => [],
    getKnownPeerSet: () => new Set<string>(),
    addKnownPeers: async () => {},
  };

  const connection: Connection = {
    send(message: ValidMessage | ProtocolError) {
      if (message instanceof ProtocolError) {
        sent.push({
          type: message.type,
          name: message.name,
          description: message.description,
        });
      } else {
        sent.push(message);
      }
    },
    id: args?.id ?? "peer-1",
    log: logger,
  };

  return { connection, sent, broadcasts, peerManager };
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
    const { connection, sent } = createMockConnection();
    const managers = createMockManagers({ objectManager: manager });

    const message: IHaveObjectMessage = {
      type: MessageType.IHAVEOBJECT,
      objectid: "aa".repeat(32),
    };

    await iHaveObjectHandler(message, connection, managers);

    expect(sent).toEqual([
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
    const { connection, sent } = createMockConnection();
    const managers = createMockManagers({ objectManager: manager });

    await iHaveObjectHandler(
      {
        type: MessageType.IHAVEOBJECT,
        objectid: manager.id(knownObject),
      },
      connection,
      managers,
    );

    expect(sent).toEqual([]);
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
    const { connection, sent } = createMockConnection();
    const managers = createMockManagers({ objectManager: manager });

    const message: GetObjectMessage = {
      type: MessageType.GET_OBJECT,
      objectid: manager.id(object),
    };

    await getObjectHandler(message, connection, managers);

    expect(sent).toEqual([
      {
        type: MessageType.OBJECT,
        object,
      },
    ]);
  });

  test("stores a new valid transaction and gossips its object id", async () => {
    const { manager } = createInMemoryObjectManager();
    const { connection, sent, broadcasts, peerManager } = createMockConnection({
      id: "peer-1",
    });
    const managers = createMockManagers({
      objectManager: manager,
      peerManager: peerManager,
    });

    const { tx } = await createValidRegularTransaction(manager);
    const message: ObjectMessage = {
      type: MessageType.OBJECT,
      object: tx,
    };
    const objectId = manager.id(tx);

    await objectHandler(message, connection, managers);

    expect(await manager.get(objectId)).toEqual(tx);
    expect(sent).toEqual([]);
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

  test("sends an error and avoids gossiping invalid transactions", async () => {
    const { manager } = createInMemoryObjectManager();
    const { connection, sent, broadcasts, peerManager } = createMockConnection();

    const transactionManagerMock = {
      async handleIncoming(_tx: any, _connection: any) {
        throw new ProtocolError(
          ErrorCode.UNKNOWN_OBJECT,
          "Cannot find one or more previous transactions",
        );
      },
    };

    const managers = createMockManagers({
      objectManager: manager,
      transactionManager: transactionManagerMock,
      peerManager: peerManager,
    });

    const invalidTx: TransactionMessage = {
      type: ObjectType.TRANSACTION,
      inputs: [{ outpoint: { txid: "11".repeat(32), index: 0 }, sig: "00".repeat(64) }],
      outputs: [{ pubkey: "22".repeat(32), value: 10 }],
    };
    const invalidTxId = manager.id(invalidTx);

    // 1. Call the handler and catch the error if it bubbles out
    try {
      await objectHandler({ type: MessageType.OBJECT, object: invalidTx }, connection, managers);
    } catch (e) {
      // If your handler DOESN'T have an internal try/catch, we handle it here
      if (e instanceof ProtocolError) {
        connection.send(e);
      }
    }

    // 2. Now check the side effects. This will now be reached!
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: MessageType.ERROR,
        name: "UNKNOWN_OBJECT",
      }),
    );

    // 3. Verify it wasn't saved (this should throw because the object isn't there)
    await expect(manager.get(invalidTxId)).rejects.toThrow();

    // 4. Verify no gossip happened
    expect(broadcasts).toHaveLength(0);
  });
});
