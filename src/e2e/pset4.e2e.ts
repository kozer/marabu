import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Socket } from "net";
import { startNode, type NodeHandle } from "../index";
import { ErrorCode, GENESIS_BLOCK } from "@/protocol/types";
import {
  P4_GLOBAL_STORE,
  TC1A,
  TC1B,
  TC1C,
  TC1E,
  TC2,
  TC3,
  TC4,
  TC5,
  TC6A,
  TC6B,
  TC7,
  TC8,
} from "./fixtures/pset4";
import { cleanDb, collectMessages, connect, oid, send, wait } from "./test_helpers";

/** Always connect to the local node, not the remote bootstrap peer. */
const E2E_DB_PATH = "./e2e_testdb_pset4";
const E2E_PEERS_FILE = "./e2e_peers_pset4.json";
const GLOBAL_STORE = new Map<string, any>(P4_GLOBAL_STORE);

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
  }, 20_000);

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
      collectMessages(sock1, 32000),
      collectMessages(sock2, 32000),
    ]);

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.UNFINDABLE_OBJECT);

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1A.BLOCK_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 40_000);

  // ── 1b: Blockchain with non-increasing timestamps ─────
  test("1b) Non-increasing timestamps → INVALID_BLOCK_TIMESTAMP", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: TC1B.BLOCK });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 3000),
      collectMessages(sock2, 3000),
    ]);

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.INVALID_BLOCK_TIMESTAMP);

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1B.BLOCK_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 10_000);

  // ── 1c: Block in the year 2077 ────────────────────────
  test("1c) Block in year 2077 → INVALID_BLOCK_TIMESTAMP", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: TC1C.BLOCK });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 3000),
      collectMessages(sock2, 3000),
    ]);

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.INVALID_BLOCK_TIMESTAMP);

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1C.BLOCK_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 10_000);

  // ── 1d: Fake genesis (valid PoW, null previd, wrong ID) ─
  test("1e) Fake genesis block → INVALID_GENESIS", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

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
      collectMessages(sock1, 3000),
      collectMessages(sock2, 3000),
    ]);

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.INVALID_GENESIS);

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === fakeGenesisId,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 10_000);

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

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.INVALID_BLOCK_COINBASE);

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1E.BLOCK_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 15_000);

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
    msgs = await collectMessages(sock, 2000, GLOBAL_STORE);

    send(sock, { type: "object", object: TC2.B2 });
    msgs = await collectMessages(sock, 2000, GLOBAL_STORE);

    send(sock, { type: "object", object: TC2.B3 });
    msgs = await collectMessages(sock, 2000, GLOBAL_STORE);

    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 3000);

    const tipMsg = msgs.find((m: any) => m.type === "chaintip");
    expect(tipMsg).toBeDefined();
    expect((tipMsg as any).blockid).toBe(TC2.B3_ID);

    sock.destroy();
  }, 25_000);

  // ── 3: Deep reorg (fork at A1, abandons 3 blocks) ─────
  // State from test 2: genesis → B1 → B2 → B3 (height 3, TC2 fixtures).
  // Chain A: genesis → A1 → A2 → A3 (height 3, same-height → no switch).
  // Chain B: genesis → A1 → B1 → B2 → B3 → B4 (height 5, TC3 fixtures).
  // Deep reorg from height 3 (TC2.B3) to height 5 (TC3.B4).
  test("3) Deep reorg — getchaintip returns deeper fork tip", async () => {
    const sock = await connect();
    let msgs = [];

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    msgs = await collectMessages(sock, 500);

    send(sock, { type: "object", object: GENESIS_BLOCK });
    msgs = await collectMessages(sock, 1000);

    send(sock, { type: "object", object: TC3.A3 });
    msgs = await collectMessages(sock, 8000, GLOBAL_STORE);

    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 2000);

    let tipMsg = msgs.find((m: any) => m.type === "chaintip") as any;
    expect(tipMsg).toBeDefined();
    expect(tipMsg.blockid).toBe(TC2.B3_ID);

    send(sock, { type: "object", object: TC3.B4 });
    const haveUntil = (m: any) => m.type === "ihaveobject" && m.objectid === TC3.B4_ID;
    await collectMessages(sock, 15000, GLOBAL_STORE, haveUntil);

    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 2000);
    const tipMsg2 = msgs.find((m: any) => m.type === "chaintip" && m.blockid === TC3.B4_ID) as any;
    expect(tipMsg2).toBeDefined();

    sock.destroy();
  }, 40_000);

  // ── 4: Non-increasing timestamp chain (N3 sent first) ─
  // N3 → N2 → N1. N3 sent first, triggers parent fetch.
  // All three blocks have timestamp 1671185419 (< genesis 1771159355).
  // Every block in the chain must emit INVALID_BLOCK_TIMESTAMP.
  test("4) Non-increasing timestamp chain → INVALID_BLOCK_TIMESTAMP", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: TC4.N3 });

    // Collect ALL messages — with cascade, sock1 receives:
    // N1 → INVALID_BLOCK_TIMESTAMP
    // N2 → INVALID_BLOCK_TIMESTAMP + UNFINDABLE_OBJECT
    // N3 → INVALID_BLOCK_TIMESTAMP + UNFINDABLE_OBJECT
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 10000, GLOBAL_STORE),
      collectMessages(sock2, 10000, GLOBAL_STORE),
    ]);

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.INVALID_BLOCK_TIMESTAMP);
    expect(errorNames).toContain(ErrorCode.UNFINDABLE_OBJECT);

    for (const id of [TC4.N1_ID, TC4.N2_ID, TC4.N3_ID]) {
      const gossipMsg = msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === id);
      expect(gossipMsg).toBeUndefined();
    }

    sock1.destroy();
    sock2.destroy();
  }, 25_000);

  // ── 5: Unavailable parent → UNFINDABLE_OBJECT ────────
  test("5) Block with unavailable parent → UNFINDABLE_OBJECT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: TC5.BLOCK });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 32000),
      collectMessages(sock2, 32000),
    ]);

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.UNFINDABLE_OBJECT);

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC5.BLOCK_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 40_000);

  // ── 6a: Invalid PoW (nonexistent parent) → error ─────
  test("6a) Block with nonexistent parent → UNFINDABLE_OBJECT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: TC6A.BLOCK });

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 32000),
      collectMessages(sock2, 32000),
    ]);

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.UNFINDABLE_OBJECT);

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC6A.BLOCK_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 40_000);

  // ── 6b: Chain on top of block with unavailable parent
  test("6b) Chain on top of invalid root → no gossip for child", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: TC6A.BLOCK });
    await collectMessages(sock1, 32000);

    send(sock1, { type: "object", object: TC6B.SECOND });
    const msgs2 = await collectMessages(sock2, 5000);

    for (const id of [TC6A.BLOCK_ID, TC6B.SECOND_ID]) {
      const gossipMsg = msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === id);
      expect(gossipMsg).toBeUndefined();
    }

    sock1.destroy();
    sock2.destroy();
  }, 40_000);

  // ── 7: Longest chain — 30-block extension ────────────
  test("7) 30-block chain — tip matches, walk returns all blocks", async () => {
    const sock = await connect();
    let msgs: any[] = [];

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    msgs = await collectMessages(sock, 500);

    send(sock, { type: "object", object: GENESIS_BLOCK });
    msgs = await collectMessages(sock, 2000);

    for (const b of TC7.BLOCKS) send(sock, { type: "object", object: b.block });
    const haveUntil = (m: any) => m.type === "ihaveobject" && m.objectid === TC7.TIP_ID;
    await collectMessages(sock, 10000, GLOBAL_STORE, haveUntil);

    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 2000);
    const tipMsg = msgs.find((m: any) => m.type === "chaintip") as any;
    expect(tipMsg).toBeDefined();
    expect(tipMsg.blockid).toBe(TC7.TIP_ID);

    let currentId: string | null = TC7.TIP_ID;
    let walkLength = 0;
    while (currentId && walkLength < 35) {
      send(sock, { type: "getobject", objectid: currentId });
      msgs = await collectMessages(sock, 300);
      const objMsg = msgs.find(
        (m: any) => m.type === "object" && m.object && oid(m.object) === currentId,
      ) as any;
      if (!objMsg) break;
      walkLength++;
      currentId = objMsg.object.previd;
    }
    expect(walkLength).toBeGreaterThanOrEqual(30);
    sock.destroy();
  }, 30_000);

  // ── 8: 3-block cascade — root fails, errors propagate ─
  // Chain: genesis → A → B → C
  // A has invalid timestamp (< genesis).  Send C, node fetches B, then A.
  // A fails → cascade: A gets INVALID_BLOCK_TIMESTAMP.
  // B, C get INVALID_BLOCK_TIMESTAMP + UNFINDABLE_OBJECT.
  test("8) 3-block cascade — errors propagate to all blocks", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    // Send tip block C → triggers parent fetch for B then A.
    send(sock1, { type: "object", object: TC8.BLOCK_C });

    const cascadeStore = new Map<string, any>([
      [TC8.CB1_ID, TC8.CB1],
      [TC8.CB2_ID, TC8.CB2],
      [TC8.CB3_ID, TC8.CB3],
      [TC8.BLOCK_A_ID, TC8.BLOCK_A],
      [TC8.BLOCK_B_ID, TC8.BLOCK_B],
      [TC8.BLOCK_C_ID, TC8.BLOCK_C],
    ]);

    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 15000, cascadeStore),
      collectMessages(sock2, 15000, cascadeStore),
    ]);

    const errorNames = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errorNames).toContain(ErrorCode.INVALID_BLOCK_TIMESTAMP);
    expect(errorNames).toContain(ErrorCode.UNFINDABLE_OBJECT);

    // Grader 2 must NOT receive gossip for any of the 3 blocks.
    for (const id of [TC8.BLOCK_A_ID, TC8.BLOCK_B_ID, TC8.BLOCK_C_ID]) {
      const gossipMsg = msgs2.find(
        (m: any) => m.type === "ihaveobject" && m.objectid === id,
      );
      expect(gossipMsg).toBeUndefined();
    }

    sock1.destroy();
    sock2.destroy();
  }, 30_000);
});
