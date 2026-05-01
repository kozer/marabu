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

const E2E_DB_PATH = "./e2e_testdb_pset4";
const E2E_PEERS_FILE = "./e2e_peers_pset4.json";
const GLOBAL_STORE = new Map<string, any>(P4_GLOBAL_STORE);

let node: NodeHandle;

const unfindableUntil = (m: any) => m.type === "error" && m.name === ErrorCode.UNFINDABLE_OBJECT;

describe("pset4", () => {
  beforeAll(async () => {
    cleanDb(E2E_DB_PATH, E2E_PEERS_FILE);
    node = await startNode({ dbPath: E2E_DB_PATH, peersFile: E2E_PEERS_FILE, isolated: true });
    await wait(500);
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
    await collectMessages(sock, 500);
  }

  test("1a) Blockchain pointing to an unavailable block → UNFINDABLE_OBJECT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC1A.BLOCK });
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000, undefined, unfindableUntil),
      collectMessages(sock2, 5000),
    ]);
    expect(msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name)).toContain(
      ErrorCode.UNFINDABLE_OBJECT,
    );
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === TC1A.BLOCK_ID),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 15_000);

  test("1b) Non-increasing timestamps → INVALID_BLOCK_TIMESTAMP", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC1B.BLOCK });
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 1000),
      collectMessages(sock2, 1000),
    ]);
    expect(msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name)).toContain(
      ErrorCode.INVALID_BLOCK_TIMESTAMP,
    );
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === TC1B.BLOCK_ID),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 5_000);

  test("1c) Block in year 2077 → INVALID_BLOCK_TIMESTAMP", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC1C.BLOCK });
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 1000),
      collectMessages(sock2, 1000),
    ]);
    expect(msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name)).toContain(
      ErrorCode.INVALID_BLOCK_TIMESTAMP,
    );
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === TC1C.BLOCK_ID),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 5_000);

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
      collectMessages(sock1, 1000),
      collectMessages(sock2, 1000),
    ]);
    expect(msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name)).toContain(
      ErrorCode.INVALID_GENESIS,
    );
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === fakeGenesisId),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 5_000);

  test("1f) Incorrect coinbase height → INVALID_BLOCK_COINBASE", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC1E.BLOCK });
    const coinbaseErr = (m: any) =>
      m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE;
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 3000, GLOBAL_STORE, coinbaseErr),
      collectMessages(sock2, 3000, GLOBAL_STORE),
    ]);
    expect(msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name)).toContain(
      ErrorCode.INVALID_BLOCK_COINBASE,
    );
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === TC1E.BLOCK_ID),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 8_000);

  test("2) Longest chain is selected — getchaintip returns longest tip", async () => {
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: GENESIS_BLOCK });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: TC2.A1 });
    await collectMessages(sock, 1000, GLOBAL_STORE);
    send(sock, { type: "getobject", objectid: TC2.A1_ID });
    const msgs = await collectMessages(sock, 1000);
    expect(
      msgs.find((m: any) => m.type === "object" && m.object && oid(m.object) === TC2.A1_ID),
    ).toBeDefined();
    for (const b of [TC2.B1, TC2.B2, TC2.B3]) {
      send(sock, { type: "object", object: b });
      await collectMessages(sock, 500, GLOBAL_STORE);
    }
    send(sock, { type: "getchaintip" });
    const res = await collectMessages(sock, 1000);
    const tipMsg = res.find((m: any) => m.type === "chaintip");
    expect(tipMsg).toBeDefined();
    expect((tipMsg as any).blockid).toBe(TC2.B3_ID);
    sock.destroy();
  }, 15_000);

  test("3) Deep reorg — getchaintip returns deeper fork tip", async () => {
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: GENESIS_BLOCK });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: TC3.A3 });
    await collectMessages(sock, 5000, GLOBAL_STORE);
    send(sock, { type: "getchaintip" });
    let msgs = await collectMessages(sock, 1000);
    expect((msgs.find((m: any) => m.type === "chaintip") as any).blockid).toBe(TC2.B3_ID);
    send(sock, { type: "object", object: TC3.B4 });
    await collectMessages(
      sock,
      8000,
      GLOBAL_STORE,
      (m: any) => m.type === "ihaveobject" && m.objectid === TC3.B4_ID,
    );
    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 1000);
    expect(msgs.find((m: any) => m.type === "chaintip" && m.blockid === TC3.B4_ID)).toBeDefined();
    sock.destroy();
  }, 25_000);

  test("4) Non-increasing timestamp chain → INVALID_BLOCK_TIMESTAMP", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC4.N3 });
    const timestampErr = (m: any) =>
      m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_TIMESTAMP;
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000, GLOBAL_STORE, timestampErr),
      collectMessages(sock2, 5000, GLOBAL_STORE),
    ]);
    const errors = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errors).toContain(ErrorCode.INVALID_BLOCK_TIMESTAMP);
    for (const id of [TC4.N1_ID, TC4.N2_ID, TC4.N3_ID])
      expect(msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === id)).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 15_000);

  test("5) Block with unavailable parent → UNFINDABLE_OBJECT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC5.BLOCK });
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000, undefined, unfindableUntil),
      collectMessages(sock2, 5000),
    ]);
    expect(msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name)).toContain(
      ErrorCode.UNFINDABLE_OBJECT,
    );
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === TC5.BLOCK_ID),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 15_000);

  test("6a) Block with nonexistent parent → UNFINDABLE_OBJECT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC6A.BLOCK });
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000, undefined, unfindableUntil),
      collectMessages(sock2, 5000),
    ]);
    expect(msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name)).toContain(
      ErrorCode.UNFINDABLE_OBJECT,
    );
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === TC6A.BLOCK_ID),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 15_000);

  test("6b) Chain on top of invalid root → no gossip for child", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC6A.BLOCK });
    await collectMessages(sock1, 5000, undefined, unfindableUntil);
    send(sock1, { type: "object", object: TC6B.SECOND });
    const msgs2 = await collectMessages(sock2, 3000);
    for (const id of [TC6A.BLOCK_ID, TC6B.SECOND_ID])
      expect(msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === id)).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 15_000);

  test("7) 30-block chain — tip matches, walk returns all blocks", async () => {
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: GENESIS_BLOCK });
    await collectMessages(sock, 500);
    for (const b of TC7.BLOCKS) send(sock, { type: "object", object: b.block });
    await collectMessages(
      sock,
      5000,
      GLOBAL_STORE,
      (m: any) => m.type === "ihaveobject" && m.objectid === TC7.TIP_ID,
    );
    send(sock, { type: "getchaintip" });
    let msgs = await collectMessages(sock, 1000);
    expect((msgs.find((m: any) => m.type === "chaintip") as any).blockid).toBe(TC7.TIP_ID);
    let currentId: string | null = TC7.TIP_ID;
    let walkLength = 0;
    while (currentId && walkLength < 35) {
      send(sock, { type: "getobject", objectid: currentId });
      msgs = await collectMessages(sock, 300);
      const obj = msgs.find(
        (m: any) => m.type === "object" && m.object && oid(m.object) === currentId,
      ) as any;
      if (!obj) break;
      walkLength++;
      currentId = obj.object.previd;
    }
    expect(walkLength).toBeGreaterThanOrEqual(30);
    sock.destroy();
  }, 20_000);

  test("8) 3-block cascade — errors propagate to all blocks", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    await seedGenesis(sock1);
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC8.BLOCK_C });
    const cascadeStore = new Map<string, any>([
      [TC8.CB1_ID, TC8.CB1],
      [TC8.CB2_ID, TC8.CB2],
      [TC8.CB3_ID, TC8.CB3],
      [TC8.BLOCK_A_ID, TC8.BLOCK_A],
      [TC8.BLOCK_B_ID, TC8.BLOCK_B],
      [TC8.BLOCK_C_ID, TC8.BLOCK_C],
    ]);
    const timestampErr = (m: any) =>
      m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_TIMESTAMP;
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 8000, cascadeStore, timestampErr),
      collectMessages(sock2, 8000, cascadeStore),
    ]);
    const errors = msgs1.filter((m: any) => m.type === "error").map((m: any) => m.name);
    expect(errors).toContain(ErrorCode.INVALID_BLOCK_TIMESTAMP);
    expect(errors).toContain(ErrorCode.UNFINDABLE_OBJECT);
    for (const id of [TC8.BLOCK_A_ID, TC8.BLOCK_B_ID, TC8.BLOCK_C_ID])
      expect(msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === id)).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 20_000);
});
