import {
  expect,
  test,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { createServer, Socket } from "net";
import { handleInboundConnection } from "@/net/connection";
import { PeerManager } from "@/peers/peerManager";
import { sendMessage, delay } from "@/shared/utils";
import { SEPARATOR } from "@/shared/constants";
import { MemoryPeerStore } from "@/peers/peerStore";
import { MessageType, ErrorCode } from "@/protocol/types";

// Simple mock logger for tests to avoid pino-pretty keeping process alive
const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
};

const db = {
  async addObject(_key: string, _value: any): Promise<void> {
    return;
  },
  async validateObject(_key: string, _value: any): Promise<boolean> {
    return true;
  },
  async getObject(_key: string): Promise<any> {
    return null;
  },
};

const TEST_PORT = 18018;

function connectToNode(port: number = TEST_PORT): Promise<Socket> {
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

function receiveMessages(
  socket: Socket,
  timeout: number = 1000,
): Promise<any[]> {
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

function waitForSocketClose(
  socket: Socket,
  timeout: number = 500,
): Promise<boolean> {
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
    server.listen(TEST_PORT);
    server.on("connection", (socket: Socket) => {
      const id = `${socket.remoteAddress}:${socket.remotePort}`;
      const ctx = {
        id,
        socket,
        peerManager,
        logger,
        db,
      };
      handleInboundConnection(ctx);
    });

    await delay(500);
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
    const occurrences = peersMessage.peers.filter(
      (p: string) => p === testPeer,
    ).length;
    expect(occurrences).toBe(1);

    await closeSocket(socket);
  });

  test("should support two parallel connections", async () => {
    const [socket1, socket2] = await Promise.all([
      connectToNode(),
      connectToNode(),
    ]);

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

      socket.write(
        JSON.stringify({ type: "peers", peers: ["not-a-peer"] }) + "\n",
      );

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

  describe("Additional Edge Cases", () => {
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

      const peersMessage = responseMessages.find(
        (m) => m.type === MessageType.PEERS,
      );
      expect(peersMessage).toBeDefined();
      expect(peersMessage).toHaveProperty("peers");

      await closeSocket(socket);
    });

    test("should accept non-canonical JSON format", async () => {
      const socket = await connectToNode();

      await receiveMessages(socket, 200);

      socket.write(
        '{ "version" : "0.10.0" , "agent" : "agent" , "type" : "hello" }\n',
      );

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

    test("should handle empty message (just newline)", async () => {
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

      const peersMessages = messages.filter(
        (m) => m.type === MessageType.PEERS,
      );
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
          (m) =>
            m.type === MessageType.ERROR &&
            m.name === ErrorCode.INVALID_HANDSHAKE,
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
          (m) =>
            m.type === MessageType.ERROR && m.name === ErrorCode.INVALID_FORMAT,
        );
        expect(errorMessage).toBeDefined();

        await closeSocket(socket);
        await delay(50);
      }
    });

    test("should handle connection without agent field (optional)", async () => {
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
