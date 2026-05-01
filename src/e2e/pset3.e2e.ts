import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startNode, type NodeHandle } from "../index";
import { ErrorCode, GENESIS_BLOCK, GENESIS_BLOCK_ID } from "@/protocol/types";
import { P3_GLOBAL_STORE, TC10, TC11, TC2, TC3, TC5, TC6, TC7, TC8, TC9 } from "./fixtures/pset3";
import { cleanDb, collectMessages, connect, oid, send, wait } from "./test_helpers";
const E2E_DB_PATH = "./e2e_testdb";
const E2E_PEERS_FILE = "./e2e_peers.json";

const GLOBAL_STORE = new Map<string, any>(P3_GLOBAL_STORE);

let node: NodeHandle;

describe("pset3", () => {
  beforeAll(async () => {
    cleanDb(E2E_DB_PATH, E2E_PEERS_FILE);
    node = await startNode({
      dbPath: E2E_DB_PATH,
      peersFile: E2E_PEERS_FILE,
      isolated: true,
    });
    // Give the node a moment to fully initialize and attempt bootstrap peer connections
    await wait(500);
  }, 10_000);

  afterAll(async () => {
    try {
      await node.shutdown();
    } catch {}
    cleanDb(E2E_DB_PATH, E2E_PEERS_FILE);
  }, 30_000);

  // ── Testcase 1: Must validate and store valid block ───
  test("Must validate and store valid block", async () => {
    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: GENESIS_BLOCK });
    await collectMessages(sock, 500);

    send(sock, { type: "getobject", objectid: GENESIS_BLOCK_ID });
    const untilObj = (id: string) => (m: any) => m.type === "object" && m.object && oid(m.object) === id;
    const messages = await collectMessages(sock, 1000, undefined, untilObj(GENESIS_BLOCK_ID));

    const objectMsg = messages.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === GENESIS_BLOCK_ID,
    );
    expect(objectMsg).toBeDefined();
    expect(oid((objectMsg as any).object)).toBe(GENESIS_BLOCK_ID);

    sock.destroy();
  }, 10_000);

  // ── Testcase 2: Block with a coinbase transaction ─────
  // Grader transcript:
  //   1. New connection, send hello
  //   2. Send block with 1 coinbase txid, previd = genesis
  //   3. Node requests the coinbase tx via getobject
  //   4. Send getobject for the block ID
  //   5. Expect the block back
  test("Must validate and store block with coinbase transaction", async () => {
    const block2 = TC2.BLOCK;
    const block2Id = TC2.BLOCK_ID;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: block2 });
    await collectMessages(sock, 500, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: block2Id });
    const untilObj = (id: string) => (m: any) => m.type === "object" && m.object && oid(m.object) === id;
    const messages = await collectMessages(sock, 1000, GLOBAL_STORE, untilObj(block2Id));

    const objectMsg = messages.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === block2Id,
    );
    expect(objectMsg).toBeDefined();
    expect(oid((objectMsg as any).object)).toBe(block2Id);

    sock.destroy();
  }, 8_000);

  // ── Testcase 3: Block with coinbase + spending earlier coinbase ─
  // Grader transcript:
  //   1. New connection, send hello
  //   2. Send block with 2 txids (coinbase + spend), previd = block2
  //   3. Node requests txids via getobject
  //   4. Send getobject for the block ID
  //   5. Expect the block back
  test("Must validate and store block spending earlier coinbase", async () => {
    const block3 = TC3.BLOCK3;
    const block3Id = TC3.BLOCK3_ID;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: block3 });
    await collectMessages(sock, 1000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: block3Id });
    const untilObj = (id: string) => (m: any) => m.type === "object" && m.object && oid(m.object) === id;
    const messages = await collectMessages(sock, 1000, GLOBAL_STORE, untilObj(block3Id));

    const objectMsg = messages.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === block3Id,
    );
    expect(objectMsg).toBeDefined();
    expect(oid((objectMsg as any).object)).toBe(block3Id);

    sock.destroy();
  }, 10_000);

  // ── Testcase 4: Block with incorrect target ───────────
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block with T != expected target
  //   3. Expect INVALID_FORMAT error
  test("Send block with incorrect target", async () => {
    const incorrectTargetBlock = {
      T: "0f00000000000000000000000000000000000000000000000000000000000000",
      created: 1771162955,
      miner: "grader",
      nonce: "a31d8edaa513aaa3e3e2fe930135f9942157fa3c135d1e435ba0c0b02252250d",
      note: "Block with incorrect target",
      previd: GENESIS_BLOCK_ID,
      txids: [],
      type: "block",
    };

    const sock = await connect();
    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: incorrectTargetBlock });

    const errUntil = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_FORMAT;
    const messages = await collectMessages(sock, 1000, undefined, errUntil);
    const errorMsg = messages.find(errUntil);
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 6_000);

  // ── Testcase 5: Coinbase conservation violation ───────
  // Grader transcript (same connection, two blocks):
  //   Part A: Send valid block with coinbase tx, verify stored
  //   Part B: Send block that violates coinbase law of conservation
  test("Block does not satisfy coinbase law of conservation", async () => {
    const blockA = TC5.BLOCK_A;
    const blockAId = TC5.BLOCK_A_ID;
    const blockB = TC5.BLOCK_B;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send valid block with coinbase, wait, then request it back
    send(sock, { type: "object", object: blockA });
    await collectMessages(sock, 1000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: blockAId });
    const untilObj = (id: string) => (m: any) => m.type === "object" && m.object && oid(m.object) === id;
    const msgsA = await collectMessages(sock, 1000, GLOBAL_STORE, untilObj(blockAId));

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid((objectMsg as any).object)).toBe(blockAId);

    // Part B: Send block that violates coinbase conservation, expect error
    send(sock, { type: "object", object: blockB });
    const coinbaseErr = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE;
    const msgsB = await collectMessages(sock, 2000, GLOBAL_STORE, coinbaseErr);

    const errorMsg = msgsB.find(coinbaseErr);
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 15_000);

  // ── Testcase 6: Coinbase spent in the same block ──────
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block with coinbase tx AND a tx spending that coinbase in same block
  //   3. Expect INVALID_TX_OUTPOINT error
  test("Coinbase spent in the same block", async () => {
    const block = TC6.BLOCK;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: block });

    const outpointErr = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT;
    const messages = await collectMessages(sock, 2000, GLOBAL_STORE, outpointErr);

    let errorMsg = messages.find(outpointErr);
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 20_000);

  // ── Testcase 7: Invalid transaction (with null signature) in block ──
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block referencing coinbase tx + an invalid tx (null sig) that
  //      doesn't exist on the network
  //   3. Node tries to fetch the unknown tx via getobject, nobody has it
  //   4. Per spec: timeout → send UNFINDABLE_OBJECT
  test("Invalid transaction (with null signature) in block", async () => {
    const block = TC7.BLOCK;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: block });

    const unfindableUntil = (m: any) => m.type === "error" && m.name === ErrorCode.UNFINDABLE_OBJECT;
    const messages = await collectMessages(sock, 8000, GLOBAL_STORE, unfindableUntil);

    const unfindableError = messages.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.UNFINDABLE_OBJECT,
    );
    const unknownError = messages.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.UNKNOWN_OBJECT,
    );
    expect(unfindableError).toBeDefined();
    expect(unknownError).toBeDefined();

    sock.destroy();
  }, 15_000);

  // ── Testcase 8: Block with two coinbase transactions ──
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block with txids listing the same coinbase txid twice
  //   3. Expect INVALID_BLOCK_COINBASE error
  test("Block with two coinbase transactions", async () => {
    const block = TC8.BLOCK;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: block });

    const coinbaseErr = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE;
    const messages = await collectMessages(sock, 2000, GLOBAL_STORE, coinbaseErr);

    const errorMsg = messages.find(coinbaseErr);
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 10_000);

  // ── Testcase 9: Double spending within a block ─────────
  // Grader transcript (same connection, two parts):
  //   Part A: Send block with coinbase tx, verify stored
  //   Part B: Send block that double-spends the coinbase, expect INVALID_TX_OUTPOINT
  test("Double spending within a block", async () => {
    const blockA = TC9.BLOCK_A;
    const blockAId = TC9.BLOCK_A_ID;
    const blockB = TC9.BLOCK_B;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send valid block with coinbase, wait, then request it back
    send(sock, { type: "object", object: blockA });
    await collectMessages(sock, 1000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: blockAId });
    const untilObj = (id: string) => (m: any) => m.type === "object" && m.object && oid(m.object) === id;
    const msgsA = await collectMessages(sock, 1000, GLOBAL_STORE, untilObj(blockAId));

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid((objectMsg as any).object)).toBe(blockAId);

    send(sock, { type: "object", object: blockB });
    const outpointErr = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT;
    const msgsB = await collectMessages(sock, 2000, GLOBAL_STORE, outpointErr);

    const errorMsg = msgsB.find(outpointErr);
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 10_000);

  // ── Testcase 10: Double spend in successive blocks ─────
  // Grader transcript (same connection, three parts):
  //   Part A: Send block with coinbase tx, verify stored
  //   Part B: Send block spending that coinbase once , verify stored
  //   Part C: Send block spending same coinbase again ,expect INVALID_TX_OUTPOINT
  test("Double spend in successive blocks", async () => {
    const blockA = TC10.BLOCK_A;
    const blockAId = TC10.BLOCK_A_ID;
    const blockB = TC10.BLOCK_B;
    const blockBId = TC10.BLOCK_B_ID;
    const blockC = TC10.BLOCK_C;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send valid block with coinbase, wait, then request it back
    send(sock, { type: "object", object: blockA });
    await collectMessages(sock, 1000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: blockAId });
    const untilObj = (id: string) => (m: any) => m.type === "object" && m.object && oid(m.object) === id;
    const msgsA = await collectMessages(sock, 1000, GLOBAL_STORE, untilObj(blockAId));

    const objectMsgA = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsgA).toBeDefined();
    expect(oid((objectMsgA as any).object)).toBe(blockAId);

    // Part B: Send block spending coinbase once, wait, then request it back
    send(sock, { type: "object", object: blockB });
    await collectMessages(sock, 1000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: blockBId });
    const msgsB = await collectMessages(sock, 1000, GLOBAL_STORE, untilObj(blockBId));

    const objectMsgB = msgsB.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockBId,
    );
    expect(objectMsgB).toBeDefined();
    expect(oid((objectMsgB as any).object)).toBe(blockBId);

    send(sock, { type: "object", object: blockC });
    const outpointErr = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT;
    const msgsC = await collectMessages(sock, 2000, GLOBAL_STORE, outpointErr);

    let errorMsg = msgsC.find(outpointErr);
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 20_000);

  // ── Testcase 11: Block with transaction that spends UTXO that doesn't exist ──
  // Grader transcript (same connection, two parts):
  //   Part A: Send standalone coinbase tx, then getobject for it — expect it back
  //   Part B: Send block whose tx spends a UTXO not in any previous block — expect INVALID_TX_OUTPOINT
  test("Block with transaction that spends UTXO that doesn't exist", async () => {
    const coinbaseTx = TC11.CB;
    const coinbaseTxId = TC11.CB_ID;
    const block = TC11.BLOCK;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send standalone coinbase tx, wait, then request it back
    send(sock, { type: "object", object: coinbaseTx });
    await collectMessages(sock, 500);

    send(sock, { type: "getobject", objectid: coinbaseTxId });
    const untilObj = (id: string) => (m: any) => m.type === "object" && m.object && oid(m.object) === id;
    const msgsA = await collectMessages(sock, 1000, GLOBAL_STORE, untilObj(coinbaseTxId));

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === coinbaseTxId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid((objectMsg as any).object)).toBe(coinbaseTxId);

    // Part B: Send block whose tx spends a UTXO not in any previous block's UTXO set
    send(sock, { type: "object", object: block });
    const outpointErr = (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT;
    const msgsB = await collectMessages(sock, 2000, GLOBAL_STORE, outpointErr);

    let errorMsg = msgsB.find(outpointErr);
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 15_000);
});
