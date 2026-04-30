import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startNode, type NodeHandle } from "../index";
import { ErrorCode, GENESIS_BLOCK } from "@/protocol/types";
import {
  P6_GLOBAL_STORE,
  TC1A,
  TC1B,
  CHAIN,
  TC2,
  TC3_VALID_TX,
  TC3_INVALID_TX,
  TC3_COINBASE_TX,
  TC3_REORG,
} from "./fixtures/pset6";
import { cleanDb, collectMessages, connect, oid, send, wait } from "./test_helpers";

const E2E_DB_PATH = "./e2e_testdb_pset6";
const E2E_PEERS_FILE = "./e2e_peers_pset6.json";
const GLOBAL_STORE = new Map<string, any>(P6_GLOBAL_STORE);

let node: NodeHandle;

describe("pset6", () => {
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
  }, 60_000);

  // ── 1a: Transaction with duplicate inputs ─────────────
  test("1a) Duplicate input outpoints → INVALID_TX_OUTPOINT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    // Send valid coinbase first so prevTx exists in objectManager.
    send(sock1, { type: "object", object: TC1A.CB_SETUP });
    await collectMessages(sock1, 2000, GLOBAL_STORE);

    // Now send the transaction with duplicate inputs.
    send(sock1, { type: "object", object: TC1A.DUP_INPUTS_TX });

    const errUntil = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT;
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000, undefined, errUntil),
      collectMessages(sock2, 5000),
    ]);

    const errorMsg = msgs1.find(errUntil);
    expect(errorMsg).toBeDefined();

    // Grader 2 must NOT receive gossip for the bad transaction.
    const dupId = oid(TC1A.DUP_INPUTS_TX);
    const gossipMsg = msgs2.find((m: any) => m.type === "ihaveobject" && m.objectid === dupId);
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 15_000);

  // ── 1b: Block with >128 character note ────────────────
  test("1b) Note > 128 chars → INVALID_FORMAT", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: TC1B.BLOCK });

    const errUntil = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_FORMAT;
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 5000, undefined, errUntil),
      collectMessages(sock2, 5000),
    ]);

    const errorMsg = msgs1.find(errUntil);
    expect(errorMsg).toBeDefined();

    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === TC1B.BLOCK_ID,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 15_000);

  // ── 2: Valid transaction with two inputs (different pubkeys) ──
  test("2) Valid tx with 2 inputs, different pubkeys → Grader 2 can getobject", async () => {
    const sock1 = await connect();
    const sock2 = await connect();

    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });
    await collectMessages(sock2, 500);

    // Seed genesis.
    send(sock1, { type: "object", object: GENESIS_BLOCK });
    await collectMessages(sock1, 2000);

    // Build chain: genesis → B1 → B2_EXTENDED
    send(sock1, { type: "object", object: CHAIN.B1 });
    await collectMessages(sock1, 5000, GLOBAL_STORE);

    send(sock1, { type: "object", object: CHAIN.B2_EXTENDED });
    await collectMessages(sock1, 5000, GLOBAL_STORE);

    // Send the valid 2-input transaction.
    send(sock1, { type: "object", object: TC2.SPEND_BOTH });
    await collectMessages(sock1, 5000, GLOBAL_STORE);

    // Grader 2 requests the transaction.
    send(sock2, { type: "getobject", objectid: TC2.SPEND_BOTH_ID });
    const msgs2 = await collectMessages(sock2, 5000);

    const objMsg = msgs2.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === TC2.SPEND_BOTH_ID,
    );
    expect(objMsg).toBeDefined();

    sock1.destroy();
    sock2.destroy();
  }, 30_000);

  // ── 3a: Mempool valid with respect to UTXO state ──────
  test("3a) Mempool valid wrt chain UTXO state", async () => {
    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);

    // Add B3 to extend the chain, giving us a fresh UTXO for later tests.
    // (B3 coinbase CB3 is to PK2.)
    send(sock, { type: "object", object: CHAIN.B3 });
    await collectMessages(sock, 5000, GLOBAL_STORE);

    // getchaintip → should be B3
    send(sock, { type: "getchaintip" });
    let msgs = await collectMessages(sock, 3000);
    const tipMsg = msgs.find((m: any) => m.type === "chaintip") as any;
    expect(tipMsg).toBeDefined();
    expect(tipMsg.blockid).toBe(CHAIN.B3_ID);

    // getmempool → mempool must be valid (even if empty)
    send(sock, { type: "getmempool" });
    msgs = await collectMessages(sock, 3000);
    const mempoolMsg = msgs.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    expect(Array.isArray(mempoolMsg.txids)).toBe(true);

    // Mempool may be empty or contain SPEND_BOTH (from test 2)
    // — both states are valid wrt UTXO.
    sock.destroy();
  }, 20_000);

  // ── 3b: Valid transaction added to mempool ────────────
  test("3b) Valid tx → mempool contains it", async () => {
    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);

    // Send a valid tx that spends CB3 (unspent UTXO).
    send(sock, { type: "object", object: TC3_VALID_TX.TX });
    await collectMessages(sock, 3000, GLOBAL_STORE);

    // Mempool should now contain the new transaction.
    send(sock, { type: "getmempool" });
    const msgs = await collectMessages(sock, 3000);
    const mempoolMsg = msgs.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    expect(mempoolMsg.txids).toContain(TC3_VALID_TX.TX_ID);

    sock.destroy();
  }, 15_000);

  // ── 3c: Invalid transaction NOT added to mempool ──────
  test("3c) Invalid tx (double spend) → mempool does NOT contain it", async () => {
    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);

    // Send a tx that double-spends CB3 (already spent by VALID_TX).
    send(sock, { type: "object", object: TC3_INVALID_TX.TX });

    const errUntil = (m: any) => m.type === "error";
    const msgs1 = await collectMessages(sock, 5000, undefined, errUntil);

    const errorMsg = msgs1.find((m: any) => m.name === ErrorCode.INVALID_TX_OUTPOINT);
    expect(errorMsg).toBeDefined();

    // Mempool should NOT contain the invalid tx.
    send(sock, { type: "getmempool" });
    const msgs2 = await collectMessages(sock, 3000);
    const mempoolMsg = msgs2.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    expect(mempoolMsg.txids).not.toContain(TC3_INVALID_TX.TX_ID);

    sock.destroy();
  }, 20_000);

  // ── 3d: Coinbase transaction NOT added to mempool ─────
  test("3d) Coinbase tx → mempool does NOT contain it", async () => {
    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);

    // Send a standalone coinbase.
    send(sock, { type: "object", object: TC3_COINBASE_TX.TX });
    await collectMessages(sock, 3000, GLOBAL_STORE);

    // Mempool should NOT contain the coinbase.
    send(sock, { type: "getmempool" });
    const msgs = await collectMessages(sock, 3000);
    const mempoolMsg = msgs.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    expect(mempoolMsg.txids).not.toContain(TC3_COINBASE_TX.TX_ID);

    sock.destroy();
  }, 15_000);

  // ── 3e: Reorg → mempool consistent with new chain ─────
  test("3e) Reorg → mempool consistent with new chain", async () => {
    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    await collectMessages(sock, 500);

    // Send fork blocks in order: B2_ALT → B3_ALT → B4_ALT.
    // B4_ALT is height 4 > current height 3 → triggers reorg.
    send(sock, { type: "object", object: TC3_REORG.B2_ALT });
    await collectMessages(sock, 5000, GLOBAL_STORE);

    send(sock, { type: "object", object: TC3_REORG.B3_ALT });
    await collectMessages(sock, 5000, GLOBAL_STORE);

    // Wait for B4_ALT to trigger reorg.
    send(sock, { type: "object", object: TC3_REORG.B4_ALT });
    const haveUntil = (m: any) => m.type === "ihaveobject" && m.objectid === TC3_REORG.B4_ALT_ID;
    await collectMessages(sock, 15000, GLOBAL_STORE, haveUntil);

    // Verify chain tip is the new longer chain.
    send(sock, { type: "getchaintip" });
    let msgs = await collectMessages(sock, 3000);
    const tipMsg = msgs.find(
      (m: any) => m.type === "chaintip" && m.blockid === TC3_REORG.B4_ALT_ID,
    ) as any;
    expect(tipMsg).toBeDefined();

    // Get mempool after reorg.
    send(sock, { type: "getmempool" });
    msgs = await collectMessages(sock, 3000);
    const mempoolMsg = msgs.find((m: any) => m.type === "mempool") as any;
    expect(mempoolMsg).toBeDefined();
    const mempoolTxids: string[] = mempoolMsg.txids;

    // i. Mempool must NOT contain transactions already in the new chain.
    const newChainTxIds = [TC3_REORG.CB2_ALT_ID, TC3_REORG.CB3_ALT_ID, TC3_REORG.CB4_ALT_ID];
    for (const id of newChainTxIds) {
      expect(mempoolTxids).not.toContain(id);
    }

    // ii. Mempool must contain transactions that were in the old chain
    //     but are not in the new chain and still valid.
    //     TX_EXTRA was in abandoned B2_EXTENDED and spends CB1 (common ancestor).
    expect(mempoolTxids).toContain(CHAIN.TX_EXTRA_ID);

    sock.destroy();
  }, 50_000);
});
