import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Socket } from "net";
import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { rmSync } from "fs";
import { startNode, type NodeHandle } from "../index";
import { SEPARATOR, SERVER_HOST, SERVER_PORT } from "@/shared/constants";
import { ErrorCode } from "@/protocol/types";
import {
  GENESIS_BLOCK,
  P4_GLOBAL_STORE,
  P4_BLOCK_MISSING_PARENT,
  P4_BLOCK_MISSING_PARENT_ID,
  P4_BLOCK_BAD_TIMESTAMP,
  P4_BLOCK_BAD_TIMESTAMP_ID,
  P4_BLOCK_FUTURE,
  P4_BLOCK_FUTURE_ID,
  P4_BLOCK_BAD_POW,
  P4_BLOCK_BAD_POW_ID,
  P4_BLOCK_WRONG_CB,
  P4_BLOCK_WRONG_CB_ID,
  P4_BLOCK_A1,
  P4_BLOCK_A1_ID,
  P4_BLOCK_B1,
  P4_BLOCK_B2,
  P4_BLOCK_B3,
  P4_BLOCK_B3_ID,
} from "./fixtures";

/** Always connect to the local node, not the remote bootstrap peer. */
const E2E_DB_PATH = "./e2e_testdb_pset4";
const E2E_PEERS_FILE = "./e2e_peers_pset4.json";

function oid(obj: any): string {
  return bytesToHex(blake2s(Buffer.from(canonicalize(obj)!, "utf8")));
}

function send(sock: Socket, msg: any) {
  const raw = canonicalize(msg)! + SEPARATOR;
  sock.write(raw);
}

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    sock.connect(SERVER_PORT, SERVER_HOST, () => resolve(sock));
    sock.on("error", reject);
  });
}

function collectMessages(
  sock: Socket,
  timeoutMs: number,
  objectStore?: Map<string, any>,
): Promise<any[]> {
  const messages: any[] = [];
  let buf = "";
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sock.removeAllListeners("data");
      resolve(messages);
    }, timeoutMs);

    sock.on("data", (data) => {
      buf += data.toString();
      const parts = buf.split(SEPARATOR);
      buf = parts.pop()!;
      for (const raw of parts) {
        if (!raw.trim()) continue;
        try {
          const msg = JSON.parse(raw);
          messages.push(msg);
          if (
            objectStore &&
            msg.type === "getobject" &&
            msg.objectid &&
            objectStore.has(msg.objectid)
          ) {
            send(sock, {
              type: "object",
              object: objectStore.get(msg.objectid),
            });
          }
        } catch {
          // ignore parse errors
        }
      }
    });

    sock.on("close", () => {
      clearTimeout(timer);
      resolve(messages);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(messages);
    });
  });
}

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanDb() {
  try {
    rmSync(E2E_DB_PATH, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(E2E_PEERS_FILE, { force: true });
  } catch {}
}

const GLOBAL_STORE = new Map<string, any>(Object.entries(P4_GLOBAL_STORE));

// ── Node lifecycle ──────────────────────────────────────

let node: NodeHandle;

describe("pset4", () => {
  beforeAll(async () => {
    cleanDb();
    node = await startNode({ dbPath: E2E_DB_PATH, peersFile: E2E_PEERS_FILE, seed: true });
    await wait(1500);
  }, 10_000);

  afterAll(async () => {
    try {
      await node.shutdown();
    } catch {}
    cleanDb();
  }, 5_000);

  // Seed genesis before invalid blockchain tests
  async function seedGenesis(sock: Socket) {
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: GENESIS_BLOCK });
    await collectMessages(sock, 2000);
  }

  // ── 1a: Blockchain pointing to an unavailable block ───
  test("1a) Blockchain pointing to an unavailable block → UNFINDABLE_OBJECT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: P4_BLOCK_MISSING_PARENT });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 8000),
      collectMessages(sock2, 8000),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.UNFINDABLE_OBJECT,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === P4_BLOCK_MISSING_PARENT_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 20_000);

  // ── 1b: Blockchain with non-increasing timestamps ─────
  test("1b) Non-increasing timestamps → INVALID_BLOCK_TIMESTAMP", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: P4_BLOCK_BAD_TIMESTAMP });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000),
      collectMessages(sock2, 5000),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_TIMESTAMP,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === P4_BLOCK_BAD_TIMESTAMP_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 20_000);

  // ── 1c: Block in the year 2077 ────────────────────────
  test("1c) Block in year 2077 → INVALID_BLOCK_TIMESTAMP", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: P4_BLOCK_FUTURE });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000),
      collectMessages(sock2, 5000),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_TIMESTAMP,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === P4_BLOCK_FUTURE_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 20_000);

  // ── 1d: Fake genesis (valid PoW, null previd, wrong ID) ─
  test("1e) Fake genesis block → INVALID_GENESIS", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    // Different note → different ID → not the real genesis
    const fakeGenesis = {
      T: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      created: 1771159355,
      miner: "FakeMiner",
      nonce: "0000000000000000000000000000000000000000000000000000000000000005",
      note: "This is NOT the real genesis block",
      previd: null,
      txids: [],
      type: "block",
    };
    const fakeGenesisId = oid(fakeGenesis);

    send(sock1, { type: "object", object: fakeGenesis });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000),
      collectMessages(sock2, 5000),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_GENESIS,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === fakeGenesisId,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 20_000);

  // ── 1e: Incorrect height in coinbase transaction ──────
  test("1f) Incorrect coinbase height → INVALID_BLOCK_COINBASE", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: P4_BLOCK_WRONG_CB });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000, GLOBAL_STORE),
      collectMessages(sock2, 5000),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === P4_BLOCK_WRONG_CB_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 20_000);

  // ── 2: Longest chain rule via getchaintip ─────────────
  test("2) Longest chain is selected — getchaintip returns longest tip", async () => {
    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);

    send(sock, { type: "object", object: GENESIS_BLOCK });
    await collectMessages(sock, 2000);

    send(sock, { type: "object", object: P4_BLOCK_A1 });
    let msgs = await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: P4_BLOCK_A1_ID });
    msgs = await collectMessages(sock, 3000);
    const a1Response = msgs.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === P4_BLOCK_A1_ID,
    );
    expect(a1Response).toBeDefined();

    send(sock, { type: "object", object: P4_BLOCK_B1 });
    msgs = await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "object", object: P4_BLOCK_B2 });
    msgs = await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "object", object: P4_BLOCK_B3 });
    msgs = await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 5000);

    const tipMsg = msgs.find((m: any) => m.type === "chaintip");
    expect(tipMsg).toBeDefined();
    expect(tipMsg.blockid).toBe(P4_BLOCK_B3_ID);

    sock.destroy();
  }, 40_000);
});
