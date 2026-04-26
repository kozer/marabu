import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Socket } from "net";
import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { rmSync } from "fs";
import { startNode, type NodeHandle } from "../index";
import { SEPARATOR, SERVER_HOST, SERVER_PORT } from "@/shared/constants";
import { ErrorCode } from "@/protocol/types";

const E2E_DB_PATH = "./e2e_testdb";
const E2E_PEERS_FILE = "./e2e_peers.json";

function oid(obj: any): string {
  return bytesToHex(blake2s(Buffer.from(canonicalize(obj)!, "utf8")));
}

function send(sock: Socket, msg: any) {
  const raw = canonicalize(msg)! + SEPARATOR;
  sock.write(raw);
}

console.log(SERVER_HOST, SERVER_PORT);
function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    sock.connect(SERVER_PORT, SERVER_HOST, () => resolve(sock));
    sock.on("error", reject);
  });
}

/**
 * Collect messages from the node until timeout.
 * Optionally auto-responds to `getobject` requests from a local object store.
 * Similar as Workshop 3.
 */
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

import {
  GENESIS_BLOCK,
  GENESIS_BLOCK_ID,
  BLOCK2,
  BLOCK2_ID,
  BLOCK3,
  BLOCK3_ID,
  BLOCK_A_5,
  BLOCK_A_5_ID,
  BLOCK_B_5,
  BLOCK6,
  BLOCK7,
  BLOCK8,
  BLOCK_A_9,
  BLOCK_A_9_ID,
  BLOCK_B_9,
  BLOCK_A_10,
  BLOCK_A_10_ID,
  BLOCK_B_10,
  BLOCK_B_10_ID,
  BLOCK_C_10,
  BLOCK11,
  TX,
  TX_OBJECTS,
} from "./fixtures";

const GLOBAL_STORE = new Map<string, any>(Object.entries(TX_OBJECTS));

let node: NodeHandle;

describe("pset3", () => {
  beforeAll(async () => {
    cleanDb();
    node = await startNode({ dbPath: E2E_DB_PATH, peersFile: E2E_PEERS_FILE, seed: true });
    // Give the node a moment to fully initialize and attempt bootstrap peer connections
    await wait(1500);
  }, 10_000);

  afterAll(async () => {
    try {
      await node.shutdown();
    } catch {}
    cleanDb();
  }, 5_000);

  // ── Testcase 1: Must validate and store valid block ───
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send genesis block as object
  //   3. (Receive node's hello + getpeers — ignore)
  //   4. Send getobject for genesis block ID
  //   5. Expect to receive the genesis block back as object
  test("Must validate and store valid block", async () => {
    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: GENESIS_BLOCK });

    send(sock, { type: "getobject", objectid: GENESIS_BLOCK_ID });

    const messages = await collectMessages(sock, 5000);

    const objectMsg = messages.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === GENESIS_BLOCK_ID,
    );

    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(GENESIS_BLOCK_ID);

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
    const block2 = BLOCK2;
    const block2Id = BLOCK2_ID;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: block2 });
    await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: block2Id });

    const messages = await collectMessages(sock, 5000, GLOBAL_STORE);

    const objectMsg = messages.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === block2Id,
    );

    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(block2Id);

    sock.destroy();
  }, 10_000);

  // ── Testcase 3: Block with coinbase + spending earlier coinbase ─
  // Grader transcript:
  //   1. New connection, send hello
  //   2. Send block with 2 txids (coinbase + spend), previd = block2
  //   3. Node requests txids via getobject
  //   4. Send getobject for the block ID
  //   5. Expect the block back
  test("Must validate and store block spending earlier coinbase", async () => {
    const block3 = BLOCK3;
    const block3Id = BLOCK3_ID;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: block3 });

    send(sock, { type: "getobject", objectid: block3Id });

    const messages = await collectMessages(sock, 5000, GLOBAL_STORE);

    const objectMsg = messages.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === block3Id,
    );

    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(block3Id);

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

    const messages = await collectMessages(sock, 3000);

    const errorMsg = messages.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_FORMAT,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 10_000);

  // ── Testcase 5: Coinbase conservation violation ───────
  // Grader transcript (same connection, two blocks):
  //   Part A: Send valid block with coinbase tx, verify stored
  //   Part B: Send block that violates coinbase law of conservation
  test("Block does not satisfy coinbase law of conservation", async () => {
    const blockA = BLOCK_A_5;
    const blockAId = BLOCK_A_5_ID;
    const blockB = BLOCK_B_5;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send valid block with coinbase, wait, then request it back
    send(sock, { type: "object", object: blockA });

    send(sock, { type: "getobject", objectid: blockAId });

    const msgsA = await collectMessages(sock, 5000, GLOBAL_STORE);

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(blockAId);

    // Part B: Send block that violates coinbase conservation, expect error
    send(sock, { type: "object", object: blockB });

    const msgsB = await collectMessages(sock, 5000, GLOBAL_STORE);

    const errorMsg = msgsB.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 25_000);

  // ── Testcase 6: Coinbase spent in the same block ──────
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block with coinbase tx AND a tx spending that coinbase in same block
  //   3. Expect INVALID_TX_OUTPOINT error
  test("Coinbase spent in the same block", async () => {
    const block = BLOCK6;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: block });

    const messages = await collectMessages(sock, 10_000, GLOBAL_STORE);

    let errorMsg = messages.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT,
    );
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
    const block = BLOCK7;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: block });

    // Node receives tx objects from GLOBAL_STORE via collectMessages.
    // The invalid tx has null signature + unfindable input.
    const messages = await collectMessages(sock, 10_000, GLOBAL_STORE);

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
    const block = BLOCK8;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: block });

    const messages = await collectMessages(sock, 5000, GLOBAL_STORE);

    const errorMsg = messages.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 10_000);

  // ── Testcase 9: Double spending within a block ─────────
  // Grader transcript (same connection, two parts):
  //   Part A: Send block with coinbase tx, verify stored
  //   Part B: Send block that double-spends the coinbase, expect INVALID_TX_OUTPOINT
  test("Double spending within a block", async () => {
    const blockA = BLOCK_A_9;
    const blockAId = BLOCK_A_9_ID;
    const blockB = BLOCK_B_9;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send valid block with coinbase, wait, then request it back
    send(sock, { type: "object", object: blockA });

    send(sock, { type: "getobject", objectid: blockAId });

    const msgsA = await collectMessages(sock, 5000, GLOBAL_STORE);

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(blockAId);

    send(sock, { type: "object", object: blockB });

    const msgsB = await collectMessages(sock, 5000, GLOBAL_STORE);

    const errorMsg = msgsB.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 25_000);

  // ── Testcase 10: Double spend in successive blocks ─────
  // Grader transcript (same connection, three parts):
  //   Part A: Send block with coinbase tx, verify stored
  //   Part B: Send block spending that coinbase once , verify stored
  //   Part C: Send block spending same coinbase again ,expect INVALID_TX_OUTPOINT
  test("Double spend in successive blocks", async () => {
    const blockA = BLOCK_A_10;
    const blockAId = BLOCK_A_10_ID;
    const blockB = BLOCK_B_10;
    const blockBId = BLOCK_B_10_ID;
    const blockC = BLOCK_C_10;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send block with coinbase tx, wait, then request it back
    send(sock, { type: "object", object: blockA });

    send(sock, { type: "getobject", objectid: blockAId });

    const msgsA = await collectMessages(sock, 5000, GLOBAL_STORE);

    const objectMsgA = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsgA).toBeDefined();
    expect(oid(objectMsgA.object)).toBe(blockAId);

    // Part B: Send block spending coinbase once (valid), wait, then request it back
    send(sock, { type: "object", object: blockB });

    send(sock, { type: "getobject", objectid: blockBId });

    const msgsB = await collectMessages(sock, 5000, GLOBAL_STORE);

    const objectMsgB = msgsB.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockBId,
    );
    expect(objectMsgB).toBeDefined();
    expect(oid(objectMsgB.object)).toBe(blockBId);

    send(sock, { type: "object", object: blockC });

    const msgsC = await collectMessages(sock, 5000, GLOBAL_STORE);

    let errorMsg = msgsC.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 35_000);

  // ── Testcase 11: Block with transaction that spends UTXO that doesn't exist ──
  // Grader transcript (same connection, two parts):
  //   Part A: Send standalone coinbase tx, then getobject for it — expect it back
  //   Part B: Send block whose tx spends a UTXO not in any previous block — expect INVALID_TX_OUTPOINT
  test("Block with transaction that spends UTXO that doesn't exist", async () => {
    const coinbaseTx = TX_OBJECTS[TX.STANDALONE];
    const coinbaseTxId = TX.STANDALONE;
    const block = BLOCK11;

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send standalone coinbase tx, then request it back
    send(sock, { type: "object", object: coinbaseTx });

    send(sock, { type: "getobject", objectid: coinbaseTxId });

    const msgsA = await collectMessages(sock, 5000, GLOBAL_STORE);

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === coinbaseTxId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(coinbaseTxId);

    // Part B: Send block whose tx spends a UTXO not in any previous block's UTXO set
    send(sock, { type: "object", object: block });

    const msgsB = await collectMessages(sock, 5000, GLOBAL_STORE);

    let errorMsg = msgsB.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 25_000);
});
