import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startNode, type NodeHandle } from "../index";
import { ErrorCode, GENESIS_BLOCK } from "@/protocol/types";
import {
  P5_GLOBAL_STORE,
  TC1A,
  TC1B,
  CHAIN,
  TC2,
  TC3_VALID_TX,
  TC3_INVALID_TX,
  TC3_COINBASE_TX,
  TC3_REORG,
  TC3_DEAD_FORK,
} from "./fixtures/pset5";
import { cleanDb, collectMessages, connect, oid, send, wait } from "./test_helpers";

const E2E_DB_PATH = "./e2e_testdb_pset5";
const E2E_PEERS_FILE = "./e2e_peers_pset5.json";
const GLOBAL_STORE = new Map<string, any>(P5_GLOBAL_STORE);

let node: NodeHandle;

describe("pset5", () => {
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
  }, 30_000);

  test("1a) Duplicate input outpoints → INVALID_TX_OUTPOINT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC1A.CB_SETUP });
    await collectMessages(sock1, 500, GLOBAL_STORE);
    send(sock1, { type: "object", object: TC1A.DUP_INPUTS_TX });
    const errUntil = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT;
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 2000, undefined, errUntil),
      collectMessages(sock2, 2000),
    ]);
    expect(msgs1.find(errUntil)).toBeDefined();
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === oid(TC1A.DUP_INPUTS_TX)),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 8_000);

  test("1b) Note > 128 chars → INVALID_FORMAT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: TC1B.BLOCK });
    const errUntil = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_FORMAT;
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 2000, undefined, errUntil),
      collectMessages(sock2, 2000),
    ]);
    expect(msgs1.find(errUntil)).toBeDefined();
    expect(
      msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === TC1B.BLOCK_ID),
    ).toBeUndefined();
    sock1.destroy();
    sock2.destroy();
  }, 8_000);

  test("2) Valid tx with 2 inputs, different pubkeys → Grader 2 can getobject", async () => {
    const sock1 = await connect();
    const sock2 = await connect();
    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);
    send(sock1, { type: "object", object: GENESIS_BLOCK });
    await collectMessages(sock1, 500);
    for (const b of [CHAIN.B1, CHAIN.B2_EXTENDED]) {
      send(sock1, { type: "object", object: b });
      await collectMessages(sock1, 1000, GLOBAL_STORE);
    }
    send(sock1, { type: "object", object: TC2.SPEND_BOTH });
    await collectMessages(sock1, 1000, GLOBAL_STORE);
    send(sock2, { type: "getobject", objectid: TC2.SPEND_BOTH_ID });
    const msgs2 = await collectMessages(sock2, 1000);
    expect(
      msgs2.find(
        (m: any) => m.type === "object" && m.object && oid(m.object) === TC2.SPEND_BOTH_ID,
      ),
    ).toBeDefined();
    sock1.destroy();
    sock2.destroy();
  }, 15_000);

  test("3a) Mempool valid wrt chain UTXO state", async () => {
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: CHAIN.B3 });
    await collectMessages(sock, 1000, GLOBAL_STORE);
    send(sock, { type: "getchaintip" });
    let msgs = await collectMessages(sock, 1000);
    expect((msgs.find((m: any) => m.type === "chaintip") as any).blockid).toBe(CHAIN.B3_ID);
    send(sock, { type: "getmempool" });
    msgs = await collectMessages(sock, 1000);
    const mempoolMsg = msgs.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    expect(Array.isArray(mempoolMsg.txids)).toBe(true);
    sock.destroy();
  }, 10_000);

  test("3b) Valid tx → mempool contains it", async () => {
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: TC3_VALID_TX.TX });
    await collectMessages(sock, 1000, GLOBAL_STORE);
    send(sock, { type: "getmempool" });
    const msgs = await collectMessages(sock, 1000);
    const mempoolMsg = msgs.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    expect(mempoolMsg.txids).toContain(TC3_VALID_TX.TX_ID);
    sock.destroy();
  }, 8_000);

  test("3c) Invalid tx (double spend) → mempool does NOT contain it", async () => {
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: TC3_INVALID_TX.TX });
    const errUntil = (m: any) => m.type === "error";
    const msgs1 = await collectMessages(sock, 2000, undefined, errUntil);
    expect(msgs1.find((m: any) => m.name === ErrorCode.INVALID_TX_OUTPOINT)).toBeDefined();
    send(sock, { type: "getmempool" });
    const msgs2 = await collectMessages(sock, 1000);
    const mempoolMsg = msgs2.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    expect(mempoolMsg.txids).not.toContain(TC3_INVALID_TX.TX_ID);
    sock.destroy();
  }, 10_000);

  test("3d) Coinbase tx → mempool does NOT contain it", async () => {
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    send(sock, { type: "object", object: TC3_COINBASE_TX.TX });
    await collectMessages(sock, 1000, GLOBAL_STORE);
    send(sock, { type: "getmempool" });
    const msgs = await collectMessages(sock, 1000);
    const mempoolMsg = msgs.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    expect(mempoolMsg.txids).not.toContain(TC3_COINBASE_TX.TX_ID);
    sock.destroy();
  }, 8_000);

  test("3e) Reorg → mempool consistent with new chain", async () => {
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);
    for (const b of [TC3_REORG.B2_ALT, TC3_REORG.B3_ALT]) {
      send(sock, { type: "object", object: b });
      await collectMessages(sock, 1000, GLOBAL_STORE);
    }
    send(sock, { type: "object", object: TC3_REORG.B4_ALT });
    await collectMessages(
      sock,
      5000,
      GLOBAL_STORE,
      (m: any) => m.type === "ihaveobject" && m.objectid === TC3_REORG.B4_ALT_ID,
    );
    send(sock, { type: "getchaintip" });
    let msgs = await collectMessages(sock, 1000);
    expect(
      msgs.find((m: any) => m.type === "chaintip" && m.blockid === TC3_REORG.B4_ALT_ID),
    ).toBeDefined();
    send(sock, { type: "getmempool" });
    msgs = await collectMessages(sock, 1000);
    const mempoolTxids: string[] =
      (msgs.find((m: any) => m.type === "mempool") as any)?.txids ?? [];
    for (const id of [TC3_REORG.CB2_ALT_ID, TC3_REORG.CB3_ALT_ID, TC3_REORG.CB4_ALT_ID])
      expect(mempoolTxids).not.toContain(id);
    expect(mempoolTxids).toContain(CHAIN.TX_EXTRA_ID);
    sock.destroy();
  }, 25_000);

  test("3f) Re-gossiped stored tx after reorg → enters mempool", async () => {
    // After test 3e, tip = B4_ALT (fork B, h=4). Fork A blocks (B2_EXTENDED, B3) dead.
    // B2_EXTENDED's coinbase UTXO NOT in active set.
    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);

    // Step 1: send tx spending B2_EXTENDED's coinbase → stored, fails mempool
    const tx = TC3_DEAD_FORK.TX_FORK_A;
    send(sock, { type: "object", object: tx });
    const errUntil = (m: any) => m.type === "error";
    let msgs = await collectMessages(sock, 3000, undefined, errUntil);
    // Expect INVALID_TX_OUTPOINT (UTXO on dead fork)
    expect(msgs.find((m: any) => m.name === ErrorCode.INVALID_TX_OUTPOINT)).toBeDefined();
    // NOT in mempool
    send(sock, { type: "getmempool" });
    msgs = await collectMessages(sock, 1000);
    let txids: string[] = (msgs.find((m: any) => m.type === "mempool") as any)?.txids ?? [];
    expect(txids).not.toContain(TC3_DEAD_FORK.TX_FORK_A_ID);

    // Step 2: send fork A extension B3→B4_DEAD→B5_DEAD, h=5 > h=4 → REORG → fork A tip
    for (const b of [CHAIN.B3, TC3_DEAD_FORK.B4_DEAD, TC3_DEAD_FORK.B5_DEAD]) {
      send(sock, { type: "object", object: b });
      await collectMessages(sock, 3000, GLOBAL_STORE);
    }
    // Verify tip is B5_DEAD
    send(sock, { type: "getchaintip" });
    msgs = await collectMessages(sock, 1000);
    expect(
      msgs.find((m: any) => m.type === "chaintip" && m.blockid === TC3_DEAD_FORK.B5_DEAD_ID),
    ).toBeDefined();

    // Step 3: re-send the SAME tx. B2_EXTENDED UTXO now available on fork A tip.
    send(sock, { type: "object", object: tx });
    await collectMessages(sock, 2000, GLOBAL_STORE);
    send(sock, { type: "getmempool" });
    msgs = await collectMessages(sock, 1000);
    txids = (msgs.find((m: any) => m.type === "mempool") as any)?.txids ?? [];
    expect(txids).toContain(TC3_DEAD_FORK.TX_FORK_A_ID);

    sock.destroy();
  }, 30_000);
});
