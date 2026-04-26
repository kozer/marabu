import { expect, test, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { createServer, Socket, type AddressInfo } from "net";
import { handleInboundConnection } from "@/net/connection";
import { PeerManager } from "@/peers/peerManager";
import { sendMessage, delay } from "@/shared/utils";
import { SEPARATOR } from "@/shared/constants";
import { MemoryPeerStore } from "@/peers/peerStore";
import {
  MessageType,
  ErrorCode,
  ObjectType,
  type ConnectedPeerContext,
  type ObjectData,
  type TransactionMessage,
} from "@/protocol/types";
import ObjectManager from "@/storage/objectManager";
import {
  createTestPrivateKey,
  getPublicKeyHex,
  signTransaction,
} from "@/test/transactionTestUtils";
import { MessageDispatcher } from "./net/MessageDispatcher";
import { TransactionManager } from "@/storage/TransactionManager";
import type pino from "pino";

// Simple mock logger for tests to avoid pino-pretty keeping process alive
const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
  trace: (..._args: any[]) => {},
};

function createObjectManager(initialObjects: ObjectData[] = []) {
  const store = new Map<string, ObjectData>();
  const db = {
    get: async (id: string) => store.get(id),
    has: async (id: string) => store.has(id),
    put: async (id: string, object: ObjectData) => {
      store.set(id, object);
    },
    batch: () => {
      const ops: Array<{ type: string; id: string; value?: any }> = [];
      return {
        put: (id: string, value: any) => ops.push({ type: "put", id, value }),
        del: (id: string) => ops.push({ type: "del", id }),
        write: async () => {
          for (const op of ops) {
            if (op.type === "put") store.set(op.id, op.value);
            else store.delete(op.id);
          }
        },
      };
    },
  } as any;

  const manager = new ObjectManager(logger as any, db);
  for (const object of initialObjects) {
    store.set(manager.id(object), object);
  }

  return { manager, store };
}

const blockManager = {
  async getUtxoSet(_blockId: string): Promise<any> {
    return null;
  },
  async getBlock(_blockId: string): Promise<any> {
    return null;
  },
  async getBlockTransactions(_block: any): Promise<any[]> {
    return [];
  },
  async storeAccepted(_result: any): Promise<void> {
    return;
  },
  async handleIncoming(_block: any, _conn: any) {
    return undefined;
  },
  async validateBlock(_block: any, _conn: any) {
    return null;
  },
  async close(): Promise<void> {
    return;
  },
} as any;

let objectManager = createObjectManager().manager;
let transactionManager: TransactionManager;
let testPort = 18018;

function connectToNode(port: number = testPort): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setTimeout(5000);

    socket.connect(port, "127.0.0.1", () => {
      socket.setTimeout(0);
      resolve(socket);
    });

    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Connection timeout"));
    });
  });
}

async function completeHandshake(socket: Socket): Promise<void> {
  await receiveMessages(socket, 200);

  sendMessage(socket, {
    type: MessageType.HELLO,
    version: "0.10.0",
    agent: "agent",
  });

  await receiveMessages(socket, 200);
}

async function createValidTransactionForNode() {
  const privateKey = createTestPrivateKey();
  const senderPubkey = await getPublicKeyHex(privateKey);
  const previousTx: TransactionMessage = {
    type: ObjectType.TRANSACTION,
    height: 0,
    outputs: [{ pubkey: senderPubkey, value: 50 }],
  };

  await objectManager.put(previousTx);
  const previousTxId = objectManager.id(previousTx);

  const tx: TransactionMessage = {
    type: ObjectType.TRANSACTION,
    inputs: [
      {
        outpoint: { txid: previousTxId, index: 0 },
        sig: null,
      },
    ],
    outputs: [{ pubkey: "22".repeat(32), value: 10 }],
  };

  tx.inputs![0]!.sig = await signTransaction(tx, privateKey);

  return {
    previousTx,
    tx,
    txid: objectManager.id(tx),
  };
}

function receiveMessages(socket: Socket, timeout: number = 1000): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    let buffer = "";

    const timeoutId = setTimeout(() => {
      socket.removeAllListeners("data");
      resolve(messages);
    }, timeout);

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            messages.push(JSON.parse(line));
          } catch (e) {
            messages.push({ raw: line, parseError: true });
          }
        }
      }
    });

    socket.on("close", () => {
      clearTimeout(timeoutId);
      resolve(messages);
    });

    socket.on("error", () => {
      clearTimeout(timeoutId);
      resolve(messages);
    });
  });
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed || socket.closed) {
      resolve();
      return;
    }
    socket.end();
    socket.on("close", resolve);
    setTimeout(() => {
      socket.destroy();
      resolve();
    }, 100);
  });
}

function waitForSocketClose(socket: Socket, timeout: number = 500): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed || socket.closed) {
      resolve(true);
      return;
    }

    const onClose = () => {
      cleanup();
      resolve(true);
    };

    const onTimeout = () => {
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      socket.off("close", onClose);
      socket.off("error", onClose);
    };

    const timeoutId = setTimeout(onTimeout, timeout);
    socket.on("close", onClose);
    socket.on("error", onClose);
  });
}

describe("Test node functionality", () => {
  let server: ReturnType<typeof createServer>;
  let peerManager: PeerManager;

  let store: MemoryPeerStore;

  beforeAll(async () => {
    store = new MemoryPeerStore();
    peerManager = new PeerManager(store, logger);
    await peerManager.load();

    server = createServer();
    server.on("connection", (socket: Socket) => {
      const id = `${socket.remoteAddress}:${socket.remotePort}`;
      const messageDispatcher = new MessageDispatcher(
        { block: blockManager, tx: transactionManager, peer: peerManager, object: objectManager },
        logger as unknown as pino.Logger,
      );
      const ctx: ConnectedPeerContext = {
        id,
        dispatcher: messageDispatcher,
        logger,
        peerManager,
      };
      handleInboundConnection(socket, ctx);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo | null;
        if (!address || typeof address === "string") {
          reject(new Error("Failed to resolve test server port"));
          return;
        }
        // Catch port instead of hardcoding to avoid conflicts with other tests or instances
        testPort = address.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await delay(500);
  });

  beforeEach(async () => {
    store.reset();
    peerManager = new PeerManager(store, logger);
    await peerManager.load();
    objectManager = createObjectManager().manager;
    transactionManager = new TransactionManager(objectManager, peerManager, logger as any);
  });

  test("should be able to connect to node", async () => {
    const socket = await connectToNode();
    expect(socket).toBeDefined();
    expect(socket.readyState).toBe("open");
    await closeSocket(socket);
  });

  test("should receive valid hello message on connect", async () => {
    const socket = await connectToNode();
    const messages = await receiveMessages(socket, 500);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]).toHaveProperty("type", MessageType.HELLO);
    expect(messages[0]).toHaveProperty("version");
    expect(messages[0]).toHaveProperty("agent");

    await closeSocket(socket);
  });

  test("should receive getpeers message after hello", async () => {
    const socket = await connectToNode();
    const messages = await receiveMessages(socket, 500);

    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]).toHaveProperty("type", MessageType.HELLO);
    expect(messages[1]).toHaveProperty("type", MessageType.GET_PEERS);

    await closeSocket(socket);
  });

  test("should handle disconnect and reconnect", async () => {
    const socket1 = await connectToNode();
    const messages1 = await receiveMessages(socket1, 500);
    expect(messages1[0]).toHaveProperty("type", MessageType.HELLO);
    await closeSocket(socket1);

    await delay(500);

    const socket2 = await connectToNode();
    const messages2 = await receiveMessages(socket2, 500);
    expect(messages2[0]).toHaveProperty("type", MessageType.HELLO);
    await closeSocket(socket2);
  });

  test("should return valid peers message after getpeers", async () => {
    const socket = await connectToNode();

    await receiveMessages(socket, 500);

    sendMessage(socket, {
      type: MessageType.HELLO,
      version: "0.10.0",
      agent: "agent",
    });

    await receiveMessages(socket, 200);

    sendMessage(socket, { type: MessageType.GET_PEERS });

    const messages = await receiveMessages(socket, 500);

    const peersMessage = messages.find((m) => m.type === MessageType.PEERS);
    expect(peersMessage).toBeDefined();
    expect(peersMessage).toHaveProperty("peers");
    expect(Array.isArray(peersMessage.peers)).toBe(true);

    await closeSocket(socket);
  });

  test("should include peers sent earlier on same connection", async () => {
    const testPeer = "140.82.50.252:18018";

    const socket = await connectToNode();
    await receiveMessages(socket, 200);

    sendMessage(socket, {
      type: MessageType.HELLO,
      version: "0.10.0",
      agent: "agent",
    });

    await receiveMessages(socket, 200);

    sendMessage(socket, {
      type: MessageType.PEERS,
      peers: [testPeer],
    });

    await receiveMessages(socket, 200);

    sendMessage(socket, { type: MessageType.GET_PEERS });

    const messages = await receiveMessages(socket, 500);
    const peersMessage = messages.find((m) => m.type === MessageType.PEERS);

    expect(peersMessage).toBeDefined();
    expect(peersMessage.peers).toContain(testPeer);

    await closeSocket(socket);
  });

  test("should ignore loopback and private peers", async () => {
    const validPeer = "140.82.50.252:18018";
    const invalidPeers = [
      "127.0.0.1:18018",
      "localhost:18018",
      "192.168.1.1:18018",
      "10.0.0.1:18018",
    ];

    const socket = await connectToNode();
    await receiveMessages(socket, 200);

    sendMessage(socket, {
      type: MessageType.HELLO,
      version: "0.10.0",
      agent: "agent",
    });

    await receiveMessages(socket, 200);

    sendMessage(socket, {
      type: MessageType.PEERS,
      peers: [validPeer, ...invalidPeers],
    });

    await receiveMessages(socket, 200);

    sendMessage(socket, { type: MessageType.GET_PEERS });

    const messages = await receiveMessages(socket, 500);
    const peersMessage = messages.find((m) => m.type === MessageType.PEERS);

    expect(peersMessage).toBeDefined();
    expect(peersMessage.peers).toContain(validPeer);
    for (const invalidPeer of invalidPeers) {
      expect(peersMessage.peers).not.toContain(invalidPeer);
    }

    await closeSocket(socket);
  });

  test("should deduplicate peers in peers message", async () => {
    const testPeer = "140.82.50.252:18018";

    const socket = await connectToNode();
    await receiveMessages(socket, 200);

    sendMessage(socket, {
      type: MessageType.HELLO,
      version: "0.10.0",
      agent: "agent",
    });

    await receiveMessages(socket, 200);

    sendMessage(socket, {
      type: MessageType.PEERS,
      peers: [testPeer, testPeer],
    });

    await receiveMessages(socket, 200);

    sendMessage(socket, { type: MessageType.GET_PEERS });

    const messages = await receiveMessages(socket, 500);
    const peersMessage = messages.find((m) => m.type === MessageType.PEERS);

    expect(peersMessage).toBeDefined();
    const occurrences = peersMessage.peers.filter((p: string) => p === testPeer).length;
    expect(occurrences).toBe(1);

    await closeSocket(socket);
  });

  test("should support two parallel connections", async () => {
    const [socket1, socket2] = await Promise.all([connectToNode(), connectToNode()]);

    const [messages1, messages2] = await Promise.all([
      receiveMessages(socket1, 500),
      receiveMessages(socket2, 500),
    ]);

    expect(messages1[0]).toHaveProperty("type", MessageType.HELLO);
    expect(messages2[0]).toHaveProperty("type", MessageType.HELLO);

    await Promise.all([closeSocket(socket1), closeSocket(socket2)]);
  });

  test("should handle split messages (defragmentation)", async () => {
    const socket = await connectToNode();

    await receiveMessages(socket, 200);

    sendMessage(socket, {
      type: MessageType.HELLO,
      version: "0.10.0",
      agent: "agent",
    });

    await receiveMessages(socket, 200);

    socket.write('{"type":');
    await delay(500);

    socket.write('"getpeers"}\n');

    const messages = await receiveMessages(socket, 500);

    const peersMessage = messages.find((m) => m.type === MessageType.PEERS);
    expect(peersMessage).toBeDefined();
    expect(peersMessage).toHaveProperty("peers");

    await closeSocket(socket);
  });

  test("should send INVALID_HANDSHAKE if message is received before hello", async () => {
    const socket = await connectToNode();

    await receiveMessages(socket, 200);

    sendMessage(socket, { type: MessageType.GET_PEERS });

    const messages = await receiveMessages(socket, 500);

    const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
    expect(errorMessage).toBeDefined();
    expect(errorMessage).toHaveProperty("name", ErrorCode.INVALID_HANDSHAKE);

    await closeSocket(socket);
  });

  describe("should send INVALID_FORMAT for invalid messages", () => {
    test("Invalid JSON: Wbgygvf7rgtyv7tfbgy{{{", async () => {
      const socket = await connectToNode();
      await receiveMessages(socket, 200);

      socket.write("Wbgygvf7rgtyv7tfbgy{{{\n");

      const messages = await receiveMessages(socket, 500);
      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeDefined();
      expect(errorMessage).toHaveProperty("name", ErrorCode.INVALID_FORMAT);

      const closed = await waitForSocketClose(socket);
      expect(closed).toBe(true);

      await closeSocket(socket);
    });

    test('Invalid type: {"type":"diufygeuybhv"}', async () => {
      const socket = await connectToNode();
      await receiveMessages(socket, 200);

      socket.write(JSON.stringify({ type: "diufygeuybhv" }) + "\n");

      const messages = await receiveMessages(socket, 500);
      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeDefined();
      expect(errorMessage).toHaveProperty("name", ErrorCode.INVALID_FORMAT);

      const closed = await waitForSocketClose(socket);
      expect(closed).toBe(true);

      await closeSocket(socket);
    });

    test('Invalid hello - missing version: {"type":"hello"}', async () => {
      const socket = await connectToNode();
      await receiveMessages(socket, 200);

      socket.write(JSON.stringify({ type: "hello" }) + "\n");

      const messages = await receiveMessages(socket, 500);
      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeDefined();
      expect(errorMessage).toHaveProperty("name", ErrorCode.INVALID_FORMAT);

      const closed = await waitForSocketClose(socket);
      expect(closed).toBe(true);

      await closeSocket(socket);
    });

    test('Invalid hello - incompatible version: {"type":"hello", "version":"jd3.x"}', async () => {
      const socket = await connectToNode();
      await receiveMessages(socket, 200);

      socket.write(JSON.stringify({ type: "hello", version: "jd3.x" }) + "\n");

      const messages = await receiveMessages(socket, 500);
      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeDefined();
      expect(errorMessage).toHaveProperty("name", ErrorCode.INVALID_FORMAT);

      const closed = await waitForSocketClose(socket);
      expect(closed).toBe(true);

      await closeSocket(socket);
    });

    test('Invalid hello - incompatible version: {"type":"hello", "version":"0.8.0"}', async () => {
      const socket = await connectToNode();
      await receiveMessages(socket, 200);

      socket.write(JSON.stringify({ type: "hello", version: "0.8.0" }) + "\n");

      const messages = await receiveMessages(socket, 500);
      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeDefined();
      expect(errorMessage).toHaveProperty("name", ErrorCode.INVALID_FORMAT);

      const closed = await waitForSocketClose(socket);
      expect(closed).toBe(true);

      await closeSocket(socket);
    });

    test('Invalid peers message: {"type":"peers", "peers":["not-a-peer"]}', async () => {
      const socket = await connectToNode();
      await receiveMessages(socket, 200);

      sendMessage(socket, {
        type: MessageType.HELLO,
        version: "0.10.0",
        agent: "agent",
      });

      await receiveMessages(socket, 200);

      socket.write(JSON.stringify({ type: "peers", peers: ["not-a-peer"] }) + "\n");

      const messages = await receiveMessages(socket, 500);
      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeDefined();
      expect(errorMessage).toHaveProperty("name", ErrorCode.INVALID_FORMAT);

      const closed = await waitForSocketClose(socket);
      expect(closed).toBe(true);

      await closeSocket(socket);
    });
  });
  test("should persist peers across reconnections", async () => {
    const testPeer = "95.179.200.100:18018";

    const socket1 = await connectToNode();
    await receiveMessages(socket1, 200);

    sendMessage(socket1, {
      type: MessageType.HELLO,
      version: "0.10.0",
      agent: "agent",
    });

    await receiveMessages(socket1, 200);

    sendMessage(socket1, {
      type: MessageType.PEERS,
      peers: [testPeer],
    });

    await closeSocket(socket1);
    await delay(500);

    const socket2 = await connectToNode();
    await receiveMessages(socket2, 200);

    sendMessage(socket2, {
      type: MessageType.HELLO,
      version: "0.10.0",
      agent: "agent",
    });

    await receiveMessages(socket2, 200);

    sendMessage(socket2, { type: MessageType.GET_PEERS });

    const messages = await receiveMessages(socket2, 500);
    const peersMessage = messages.find((m) => m.type === MessageType.PEERS);

    expect(peersMessage).toBeDefined();
    expect(peersMessage.peers).toContain(testPeer);

    await closeSocket(socket2);
  });

  describe("object exchange", () => {
    test("returns a newly submitted valid transaction to the same peer", async () => {
      const socket = await connectToNode();
      await completeHandshake(socket);
      const { tx, txid } = await createValidTransactionForNode();

      sendMessage(socket, {
        type: MessageType.OBJECT,
        object: tx,
      });
      await receiveMessages(socket, 200);

      sendMessage(socket, {
        type: MessageType.GET_OBJECT,
        objectid: txid,
      });

      const messages = await receiveMessages(socket, 500);
      const objectMessage = messages.find(
        (m) => m.type === MessageType.OBJECT && m.object && m.object.type,
      );

      expect(objectMessage).toEqual({
        type: MessageType.OBJECT,
        object: tx,
      });

      await closeSocket(socket);
    });

    test("returns a newly submitted valid transaction to another peer", async () => {
      const [sender, receiver] = await Promise.all([connectToNode(), connectToNode()]);
      await Promise.all([completeHandshake(sender), completeHandshake(receiver)]);
      const { tx, txid } = await createValidTransactionForNode();

      sendMessage(sender, {
        type: MessageType.OBJECT,
        object: tx,
      });
      await receiveMessages(sender, 200);
      await receiveMessages(receiver, 300);

      sendMessage(receiver, {
        type: MessageType.GET_OBJECT,
        objectid: txid,
      });

      const messages = await receiveMessages(receiver, 500);
      const objectMessage = messages.find(
        (m) => m.type === MessageType.OBJECT && m.object && m.object.type,
      );

      expect(objectMessage).toEqual({
        type: MessageType.OBJECT,
        object: tx,
      });

      await Promise.all([closeSocket(sender), closeSocket(receiver)]);
    });

    test("gossips ihaveobject to other peers for a new valid transaction", async () => {
      const [sender, receiver] = await Promise.all([connectToNode(), connectToNode()]);
      await Promise.all([completeHandshake(sender), completeHandshake(receiver)]);
      const { tx, txid } = await createValidTransactionForNode();

      await receiveMessages(receiver, 200);

      sendMessage(sender, {
        type: MessageType.OBJECT,
        object: tx,
      });

      const receiverMessages = await receiveMessages(receiver, 500);
      const gossipMessage = receiverMessages.find((m) => m.type === MessageType.IHAVEOBJECT);

      expect(gossipMessage).toEqual({
        type: MessageType.IHAVEOBJECT,
        objectid: txid,
      });

      await Promise.all([closeSocket(sender), closeSocket(receiver)]);
    });

    test("requests an unknown object after receiving ihaveobject", async () => {
      const socket = await connectToNode();
      await completeHandshake(socket);
      const unknownId = "ab".repeat(32);

      sendMessage(socket, {
        type: MessageType.IHAVEOBJECT,
        objectid: unknownId,
      });

      const messages = await receiveMessages(socket, 500);
      const getObjectMessage = messages.find((m) => m.type === MessageType.GET_OBJECT);

      expect(getObjectMessage).toEqual({
        type: MessageType.GET_OBJECT,
        objectid: unknownId,
      });

      await closeSocket(socket);
    });

    test("rejects invalid transactions and does not gossip them", async () => {
      const [sender, receiver] = await Promise.all([connectToNode(), connectToNode()]);
      await Promise.all([completeHandshake(sender), completeHandshake(receiver)]);

      sendMessage(sender, {
        type: MessageType.OBJECT,
        object: {
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
        },
      });

      const senderMessages = await receiveMessages(sender, 500);
      const receiverMessages = await receiveMessages(receiver, 500);

      const errorMessage = senderMessages.find((m) => m.type === MessageType.ERROR);
      const gossipMessage = receiverMessages.find((m) => m.type === MessageType.IHAVEOBJECT);

      expect(errorMessage).toBeDefined();
      expect(errorMessage).toHaveProperty("name", ErrorCode.UNKNOWN_OBJECT);
      expect(gossipMessage).toBeUndefined();

      await Promise.all([closeSocket(sender), closeSocket(receiver)]);
    });
  });

  describe("Other cases", () => {
    test("should handle multiple messages in single packet", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      const messages = [
        JSON.stringify({
          type: MessageType.HELLO,
          version: "0.10.0",
          agent: "agent",
        }),
        JSON.stringify({ type: MessageType.GET_PEERS }),
      ];
      socket.write(messages.join("\n") + "\n");

      const responseMessages = await receiveMessages(socket, 500);

      const peersMessage = responseMessages.find((m) => m.type === MessageType.PEERS);
      expect(peersMessage).toBeDefined();
      expect(peersMessage).toHaveProperty("peers");

      await closeSocket(socket);
    });

    test("should accept non-canonical JSON format", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      socket.write('{ "version" : "0.10.0" , "agent" : "agent" , "type" : "hello" }\n');

      const messages = await receiveMessages(socket, 500);

      const errorMessage = messages.find((m) => m.type === "error");
      expect(errorMessage).toBeUndefined();

      // Now send getpeers to verify handshake completed
      socket.write(JSON.stringify({ type: "getpeers" }) + "\n");
      const responseMessages = await receiveMessages(socket, 500);

      const peersMessage = responseMessages.find((m) => m.type === "peers");
      expect(peersMessage).toBeDefined();

      await closeSocket(socket);
    });

    test("should handle newline message", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      socket.write("\n");

      await delay(500);

      sendMessage(socket, {
        type: MessageType.HELLO,
        version: "0.10.0",
        agent: "agent",
      });

      const messages = await receiveMessages(socket, 500);

      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeUndefined();

      await closeSocket(socket);
    });

    test("should handle whitespace-only message", async () => {
      const socket = await connectToNode();

      // Wait for initial messages
      await receiveMessages(socket, 200);

      // Send whitespace only
      socket.write("   \n");

      // Wait a bit
      await delay(500);

      // Send valid hello
      sendMessage(socket, {
        type: MessageType.HELLO,
        version: "0.10.0",
        agent: "agent",
      });

      const messages = await receiveMessages(socket, 500);

      // Should not have errored
      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeUndefined();

      await closeSocket(socket);
    });

    test("should handle messages with extra newlines between them", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      socket.write(
        JSON.stringify({
          type: MessageType.HELLO,
          version: "0.10.0",
          agent: "agent",
        }) + SEPARATOR.repeat(3),
      );
      await delay(50);
      socket.write(JSON.stringify({ type: MessageType.GET_PEERS }) + "\n");

      const messages = await receiveMessages(socket, 500);

      const peersMessage = messages.find((m) => m.type === MessageType.PEERS);
      expect(peersMessage).toBeDefined();

      await closeSocket(socket);
    });

    test("should handle very long message buffer", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      sendMessage(socket, {
        type: MessageType.HELLO,
        version: "0.10.0",
        agent: "agent",
      });

      await receiveMessages(socket, 200);

      for (let i = 0; i < 10; i++) {
        sendMessage(socket, { type: MessageType.GET_PEERS });
      }

      const messages = await receiveMessages(socket, 1000);

      const peersMessages = messages.filter((m) => m.type === MessageType.PEERS);
      expect(peersMessages.length).toBeGreaterThanOrEqual(1);

      await closeSocket(socket);
    });

    test("should handle version boundaries correctly", async () => {
      for (const version of ["0.10.0", "0.10.5", "0.10.99"]) {
        const socket = await connectToNode();
        await receiveMessages(socket, 200);

        sendMessage(socket, {
          type: MessageType.HELLO,
          version,
          agent: "agent",
        });

        const messages = await receiveMessages(socket, 500);

        const errorMessage = messages.find(
          (m) => m.type === MessageType.ERROR && m.name === ErrorCode.INVALID_HANDSHAKE,
        );
        expect(errorMessage).toBeUndefined();

        await closeSocket(socket);
        await delay(50);
      }

      for (const version of ["0.9.0", "0.11.0", "5.8.2", "jd.kfj"]) {
        const socket = await connectToNode();
        await receiveMessages(socket, 200);

        sendMessage(socket, {
          type: MessageType.HELLO,
          version,
          agent: "agent",
        });

        const messages = await receiveMessages(socket, 500);

        const errorMessage = messages.find(
          (m) => m.type === MessageType.ERROR && m.name === ErrorCode.INVALID_FORMAT,
        );
        expect(errorMessage).toBeDefined();

        await closeSocket(socket);
        await delay(50);
      }
    });

    test("should handle connection without agent field", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      sendMessage(socket, {
        type: MessageType.HELLO,
        version: "0.10.0",
      });

      const messages = await receiveMessages(socket, 500);

      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeUndefined();

      await closeSocket(socket);
    });

    test("should handle peers message with empty peers array", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      sendMessage(socket, {
        type: MessageType.HELLO,
        version: "0.10.0",
        agent: "agent",
      });

      await receiveMessages(socket, 200);

      sendMessage(socket, {
        type: MessageType.PEERS,
        peers: [],
      });

      const messages = await receiveMessages(socket, 500);

      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeUndefined();

      await closeSocket(socket);
    });

    test("should handle peers message with duplicate peers", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      sendMessage(socket, {
        type: MessageType.HELLO,
        version: "0.10.0",
        agent: "agent",
      });

      await receiveMessages(socket, 200);

      sendMessage(socket, {
        type: MessageType.PEERS,
        peers: ["95.179.158.137:18018", "95.179.158.137:18018"],
      });

      const messages = await receiveMessages(socket, 500);

      const errorMessage = messages.find((m) => m.type === MessageType.ERROR);
      expect(errorMessage).toBeUndefined();

      await closeSocket(socket);
    });
  });
});
