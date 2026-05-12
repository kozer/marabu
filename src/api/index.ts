import Fastify from "fastify";
import pino from "pino";
import { Socket } from "net";
import { sendMessage, signTransaction } from "@/shared/utils";
import keys from "../../keys.json" with { type: "json" };

const PRIVATE_KEY = new Uint8Array(Buffer.from(keys.secretKey, "hex"));
import { MessageType } from "@/protocol/types";

const logger = pino({ level: process.env.LOG_LEVEL || "debug" });
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" } });

const NODE_HOST = process.env.NODE_HOST || "127.0.0.1";
const NODE_PORT = parseInt(process.env.NODE_PORT || "18018", 10);

// CORS for dev (Vite on different port)
app.addHook("onSend", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
});
app.options("*", async (_req, reply) => reply.status(204).send());

// ── Routes ──────────────────────────────────────────────────────────

// GET /utxos?pubkey=<hex> — relays to node via P2P LEDGER message
app.get<{ Querystring: { pubkey?: string } }>("/utxos", async (request, reply) => {
  const { pubkey } = request.query;
  if (!pubkey) {
    return reply.status(400).send({ error: "pubkey query param required" });
  }

  try {
    const utxos = await requestLedger(pubkey);
    return { utxos };
  } catch (e) {
    logger.error({ err: e }, "Ledger request failed");
    return reply.status(502).send({ error: (e as Error).message });
  }
});

// POST /tx — relays transaction to node via P2P OBJECT message
app.post("/tx", async (request, reply) => {
  try {
    const txid = await sendTxToNode(request.body);
    return { status: "ok", txid };
  } catch (e) {
    logger.error({ err: e }, "Transaction submit failed");
    return reply.status(502).send({ error: (e as Error).message });
  }
});

// ── P2P helpers ─────────────────────────────────────────────────────

function p2pRequest(
  sendAfterHandshake: (socket: Socket) => void,
  onMessage: (msg: any, socket: Socket) => boolean | void,
  timeoutMs = 5000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = "";
    const messages: any[] = [];
    let handshook = false;

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Request timeout"));
    }, timeoutMs);

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          messages.push(msg);

          if (!handshook && msg.type === MessageType.HELLO) {
            handshook = true;
            sendAfterHandshake(socket);
          }

          if (handshook && onMessage(msg, socket)) {
            clearTimeout(timeout);
            socket.end();
            resolve(messages);
            return;
          }
        } catch {}
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(messages);
    });

    socket.connect(NODE_PORT, NODE_HOST);
  });
}

async function requestLedger(pubkey: string) {
  const messages = await p2pRequest(
    (socket) => {
      sendMessage(socket, {
        type: "hello",
        version: "0.10.0",
        agent: "MarabuLedger",
      } as any);
      sendMessage(socket, {
        type: "ledger",
        pk: pubkey,
      } as any);
    },
    (msg) => msg.type === MessageType.IHAVELEDGER,
  );

  for (const msg of messages) {
    if (msg.type === MessageType.IHAVELEDGER) {
      return (msg.utxos as any[]).map((u: any) => ({
        txid: u.txid,
        index: u.index,
        value: u.output.value,
        pubkey: u.output.pubkey,
      }));
    }
  }

  throw new Error("No ledger response from node");
}

async function sendTxToNode(tx: any): Promise<string> {
  const signed = await signTx(tx);
  const messages = await p2pRequest(
    (socket) => {
      sendMessage(socket, {
        type: MessageType.HELLO,
        version: "0.10.0",
        agent: "MarabuLedger",
      } as any);
      sendMessage(socket, {
        type: MessageType.OBJECT,
        object: signed,
      } as any);
    },
    (msg) => msg.type === MessageType.ERROR || msg.type === MessageType.IHAVEOBJECT,
  );

  for (const msg of messages) {
    if (msg.type === MessageType.ERROR) {
      throw new Error(`Node rejected: ${msg.name} — ${msg.description}`);
    }
    if (msg.type === MessageType.IHAVEOBJECT) {
      return msg.objectid;
    }
  }
  throw new Error("No response from node");
}

async function signTx(tx: any): Promise<any> {
  const sig = await signTransaction(tx, PRIVATE_KEY);
  return {
    ...tx,
    inputs: tx.inputs.map((inp: any) => ({ ...inp, sig })),
  };
}

// ── Start ────────────────────────────────────────────────────────────

app.listen({ port: 3000 }, () =>
  logger.info(`API listening on http://localhost:3000 (node at ${NODE_HOST}:${NODE_PORT})`),
);

process.on("SIGINT", async () => {
  await app.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await app.close();
  process.exit(0);
});
