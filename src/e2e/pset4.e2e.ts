import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Socket } from "net";
import { startNode, type NodeHandle } from "../index";
import { ErrorCode, GENESIS_BLOCK } from "@/protocol/types";
import { P4_GLOBAL_STORE, TC1A, TC1B, TC1C, TC1E, TC2, TC3 } from "./fixtures/pset4";
import { cleanDb, collectMessages, connect, oid, send, wait } from "./test_helpers";

/** Always connect to the local node, not the remote bootstrap peer. */
const E2E_DB_PATH = "./e2e_testdb_pset4";
const E2E_PEERS_FILE = "./e2e_peers_pset4.json";
const GLOBAL_STORE = new Map<string, any>(P4_GLOBAL_STORE);

// ── Node lifecycle ──────────────────────────────────────

let node: NodeHandle;

describe("pset4", () => {
  beforeAll(async () => {
    cleanDb(E2E_DB_PATH, E2E_PEERS_FILE);
    node = await startNode({
      dbPath: E2E_DB_PATH,
      peersFile: E2E_PEERS_FILE,
      isolated: true,
    });
    await wait(1500);
  }, 10_000);

  afterAll(async () => {
    try {
      await node.shutdown();
    } catch {}
    cleanDb(E2E_DB_PATH, E2E_PEERS_FILE);
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

    send(sock1, { type: "object", object: TC1A.BLOCK });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 8000),
      collectMessages(sock2, 8000),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.UNFINDABLE_OBJECT,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1A.BLOCK_ID,
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

    send(sock1, { type: "object", object: TC1B.BLOCK });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000),
      collectMessages(sock2, 5000),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_TIMESTAMP,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1B.BLOCK_ID,
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

    send(sock1, { type: "object", object: TC1C.BLOCK });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000),
      collectMessages(sock2, 5000),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_TIMESTAMP,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1C.BLOCK_ID,
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

    send(sock1, { type: "object", object: TC1E.BLOCK });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000, GLOBAL_STORE),
      collectMessages(sock2, 5000, GLOBAL_STORE),
    ]);

    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE,
    );
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1E.BLOCK_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 20_000);

  // ── 2: Longest chain rule via getchaintip ─────────────
  test("2) Longest chain is selected — getchaintip returns longest tip", async () => {
    const sock = await connect();
    let msgs = [];

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    msgs = await collectMessages(sock, 500);
    send(sock, { type: "object", object: GENESIS_BLOCK });
    msgs = await collectMessages(sock, 2000);

    send(sock, { type: "object", object: TC2.A1 });
    msgs = await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: TC2.A1_ID });
    msgs = await collectMessages(sock, 3000);
    const a1Response = msgs.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === TC2.A1_ID,
    );
    expect(a1Response).toBeDefined();

    send(sock, { type: "object", object: TC2.B1 });
    msgs = await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "object", object: TC2.B2 });
    msgs = await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "object", object: TC2.B3 });
    msgs = await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 5000);

    const tipMsg = msgs.find((m: any) => m.type === "chaintip");
    expect(tipMsg).toBeDefined();
    expect((tipMsg as any).blockid).toBe(TC2.B3_ID);

    sock.destroy();
  }, 40_000);

  // ── 3: Deep reorg (fork at A1, abandons 2 blocks) ─────
  // Chain A: genesis → A1 → A2 → A3 (height 3)
  // Chain B: genesis → A1 → B1 → B2 → B3 → B4 (height 4)
  // Common ancestor: A1. Abandons A2, A3. Adopts B1–B4.
  test("3) Deep reorg — getchaintip returns deeper fork tip", async () => {
    const sock = await connect();
    let msgs = [];

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    msgs = await collectMessages(sock, 500);

    send(sock, { type: "object", object: GENESIS_BLOCK });
    msgs = await collectMessages(sock, 1000);

    send(sock, { type: "object", object: TC3.A3 });
    msgs = await collectMessages(sock, 10000, GLOBAL_STORE);

    // Verify tip is A3
    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 3000);

    let tipMsg = msgs.find((m: any) => m.type === "chaintip") as any;
    expect(tipMsg).toBeDefined();
    expect(tipMsg.blockid).toBe(TC3.A3_ID);

    send(sock, { type: "object", object: TC3.B4 });
    await collectMessages(sock, 20000, GLOBAL_STORE);

    // Verify tip is B4 (reorg happened)
    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 3000);
    tipMsg = msgs.find((m: any) => m.type === "chaintip") as any;
    expect(tipMsg).toBeDefined();
    expect(tipMsg.blockid).toBe(TC3.B4_ID);

    sock.destroy();
  }, 60_000);
});
