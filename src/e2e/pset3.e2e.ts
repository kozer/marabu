import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Socket } from "net";
import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { rmSync } from "fs";
import { startNode, type NodeHandle } from "../index";
import { SEPARATOR, SERVER_HOST, SERVER_PORT } from "@/shared/constants";
import { ErrorCode } from "@/protocol/types";

/** Always connect to the local node, not the remote bootstrap peer. */
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

// ── Grader objects (exact from transcript) ───────────────

const GENESIS_BLOCK = {
  T: "00000000abc00000000000000000000000000000000000000000000000000000",
  created: 1771159355,
  miner: "Marabu",
  nonce: "00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347",
  note: "Financial Times 2026-02-13: Crypto's battle with the banks is splitting Trump's base",
  previd: null,
  txids: [],
  type: "block",
};

const GENESIS_BLOCK_ID = "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6";

// Coinbase for Block 2
const CB_TX_BLOCK2 = {
  type: "transaction",
  height: 1,
  outputs: [
    {
      pubkey: "026a04bbd00f7e7742353776c142c96c518ca901306d6b76f77ec30022522501",
      value: 50000000000000,
    },
  ],
};
const CB_TX_BLOCK2_ID = "e2e3d5919de1de1338217bfd1d364bf381c2c7336e0c85c46e4ae86232c26529";

const GLOBAL_STORE = new Map<string, any>();
GLOBAL_STORE.set(CB_TX_BLOCK2_ID, CB_TX_BLOCK2);

// ── Node lifecycle ──────────────────────────────────────

let node: NodeHandle;

describe("pset3", () => {
  beforeAll(async () => {
    cleanDb();
    node = await startNode({ dbPath: E2E_DB_PATH, peersFile: E2E_PEERS_FILE });
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
    const block2 = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771162955,
      miner: "grader",
      nonce: "19be8f41d0c616a4ea8e7e2accfa9d748318624e9cd39a0d53051187be1230cc",
      note: "This block has a coinbase transaction",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: ["e2e3d5919de1de1338217bfd1d364bf381c2c7336e0c85c46e4ae86232c26529"],
      type: "block",
    };
    const block2Id = "000000001a8a21aa884e5fa85a23a372a521d0ec3d74d2aaece160d306d0d9ab";

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: block2 });
    await collectMessages(sock, 3000, GLOBAL_STORE);

    send(sock, { type: "getobject", objectid: block2Id });

    const messages = await collectMessages(sock, 5000);

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
    const block3 = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771166555,
      miner: "grader",
      nonce: "cfe9618f4dd22f37bfc237cacd8cb930d9181b10881b65ee19ebfef4f4884fa7",
      note: "This block has another coinbase and spends earlier coinbase",
      previd: "000000001a8a21aa884e5fa85a23a372a521d0ec3d74d2aaece160d306d0d9ab",
      txids: [
        "a633520faec43d9dd868df547d397d3d1b0c326f9864f48eb8655f7f33cece95",
        "f4535e84ded732f4ddacbb07133c2391844851da8e7f8b9484cff03ca833be0b",
      ],
      type: "block",
    };
    const block3Id = "000000008852948c999acdfebe402d7e8a146a55c34b1a7c40960eb244b2f7e4";

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock, { type: "object", object: block3 });

    send(sock, { type: "getobject", objectid: block3Id });

    const messages = await collectMessages(sock, 5000);

    const objectMsg = messages.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === block3Id,
    );

    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(block3Id);

    sock.destroy();
  }, 10_000);

  // ── Testcase 4: Invalid PoW block — error + no gossip ─
  // Grader transcript:
  //   Two connections: Grader 1 sends invalid block, Grader 2 listens.
  //   1. Grader 1 connects, sends hello
  //   2. Grader 2 connects, sends hello
  //   3. Grader 1 sends block with invalid PoW
  //   4. Expect INVALID_BLOCK_POW error on Grader 1
  //   5. Expect NO ihaveobject on Grader 2
  test("Send invalid PoW block and do not gossip invalid block", async () => {
    const invalidPowBlock = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1671148915,
      miner: "grader",
      nonce: "65006bdb37ff504e2b3eb354b8203d13bd08d94c69d71cbaa604c167c39bfe1b",
      note: "Block with invalid PoW",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: [],
      type: "block",
    };
    const invalidBlockId = oid(invalidPowBlock);

    // Open two connections
    const sock1 = await connect();
    const sock2 = await connect();

    // Both complete handshake
    send(sock1, { agent: "Grader 1", type: "hello", version: "0.10.0" });
    send(sock2, { agent: "Grader 2", type: "hello", version: "0.10.0" });

    await collectMessages(sock2, 500);

    send(sock1, { type: "object", object: invalidPowBlock });

    // Collect messages on both connections
    const [msgs1, msgs2] = await Promise.all([
      collectMessages(sock1, 3000),
      collectMessages(sock2, 3000),
    ]);

    // Expect INVALID_BLOCK_POW error on Grader 1
    const errorMsg = msgs1.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_POW,
    );
    expect(errorMsg).toBeDefined();

    // Expect NO ihaveobject for the invalid block on Grader 2
    const gossipMsg = msgs2.find(
      (m: any) => m.type === "ihaveobject" && m.objectid === invalidBlockId,
    );
    expect(gossipMsg).toBeUndefined();

    sock1.destroy();
    sock2.destroy();
  }, 10_000);

  // ── Testcase 5: Block with incorrect target ───────────
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
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
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

  // ── Testcase 6: Block with invalid proof-of-work ──────
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block with valid target but nonce that doesn't satisfy PoW
  //   3. Expect INVALID_BLOCK_POW error
  test("Send block with invalid proof-of-work", async () => {
    const invalidPowBlock2 = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771163955,
      miner: "grader",
      nonce: "0000000000000000000000000000000000000000000000000000000000000001",
      note: "Block with invalid PoW",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: [],
      type: "block",
    };

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: invalidPowBlock2 });

    const messages = await collectMessages(sock, 3000);

    const errorMsg = messages.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_POW,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 10_000);

  // ── Testcase 7: Coinbase conservation violation ───────
  // Grader transcript (same connection, two blocks):
  //   Part A: Send valid block with coinbase tx, verify stored
  //   Part B: Send block that violates coinbase law of conservation
  test("Block does not satisfy coinbase law of conservation", async () => {
    const blockA = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771170155,
      miner: "grader",
      nonce: "3d9326cbbce4311f922b0a671d4c1d83c528efaee5d72dbf9cd61660d6b671d1",
      note: "This block has a coinbase transaction",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: ["6e77eb8eb23aa6c6dfb28ac72b38116d4826c6a96299199ae0013654bc71a5fb"],
      type: "block",
    };
    const blockAId = "0000000025686ecaf9edb4eba5146e73099636dc5f856f363313c22b3237d223";

    const blockB = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771173755,
      miner: "grader",
      nonce: "6a9e3d7de241ba5bd31d66cf1f0828a04ce33d0a28d55b91fd2924d243005832",
      note: "This block violates the law of conservation",
      previd: "0000000025686ecaf9edb4eba5146e73099636dc5f856f363313c22b3237d223",
      txids: [
        "9baa94270d6d5c62dd4180f2fc8b061eda8a69ee7448a17ad7678bb6c0d2f8f0",
        "be80036646cfdc85b27c1564a3160d44ec5c30ec14f3c401f724ec3f1742ca34",
      ],
      type: "block",
    };

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send valid block with coinbase, wait, then request it back
    send(sock, { type: "object", object: blockA });

    send(sock, { type: "getobject", objectid: blockAId });

    const msgsA = await collectMessages(sock, 5000);

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(blockAId);

    // Part B: Send block that violates coinbase conservation, expect error
    send(sock, { type: "object", object: blockB });

    const msgsB = await collectMessages(sock, 5000);

    const errorMsg = msgsB.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 25_000);

  // ── Testcase 8: Coinbase spent in the same block ──────
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block with coinbase tx AND a tx spending that coinbase in same block
  //   3. Expect INVALID_TX_OUTPOINT error
  test("Coinbase spent in the same block", async () => {
    const block = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771173755,
      miner: "grader",
      nonce: "fc4506d7c75f303dcb0d68641ea04d9815e73f18f7f7770df183f8ef6c93ecb5",
      note: "This block has a transaction spending the coinbase",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: [
        "6e77eb8eb23aa6c6dfb28ac72b38116d4826c6a96299199ae0013654bc71a5fb",
        "be80036646cfdc85b27c1564a3160d44ec5c30ec14f3c401f724ec3f1742ca34",
      ],
      type: "block",
    };

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: block });

    const messages = await collectMessages(sock, 15_000);

    let errorMsg = messages.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 20_000);

  // ── Testcase 9: Invalid transaction (with null signature) in block ──
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block referencing coinbase tx + an invalid tx (null sig) that
  //      doesn't exist on the network
  //   3. Node tries to fetch the unknown tx via getobject, nobody has it
  //   4. Per spec: timeout → send UNFINDABLE_OBJECT
  test("Invalid transaction (with null signature) in block", async () => {
    const block = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771177355,
      miner: "grader",
      nonce: "db24f2b5f712ec3a3698eaf48fadc1b3ee86c140e2a6d60d9aba0272975ea5fa",
      note: "This block contains an invalid transaction",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: [
        "6e77eb8eb23aa6c6dfb28ac72b38116d4826c6a96299199ae0013654bc71a5fb",
        "e52a193089f62a81a839f29ae81f078eefb73d606b054af67bf46f824adfe527",
      ],
      type: "block",
    };

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: block });

    // Node will try to fetch the unknown tx e52a1930... from peers.
    // findObject has a 4s timeout. Wait long enough for the error to arrive.
    const messages = await collectMessages(sock, 10_000);

    // Per spec: if timeout waiting for a transaction, send UNFINDABLE_OBJECT.
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

  // ── Testcase 10: Block with two coinbase transactions ──
  // Grader transcript:
  //   1. Connect, send hello
  //   2. Send block with txids listing the same coinbase txid twice
  //   3. Expect INVALID_BLOCK_COINBASE error
  test("Block with two coinbase transactions", async () => {
    const block = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771180955,
      miner: "grader",
      nonce: "d16b98c66bb8262a291eb1c2d9d743245c4c88303490003cb4d3702bbc15835b",
      note: "This block has 2 coinbase transactions",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: [
        "6e77eb8eb23aa6c6dfb28ac72b38116d4826c6a96299199ae0013654bc71a5fb",
        "6e77eb8eb23aa6c6dfb28ac72b38116d4826c6a96299199ae0013654bc71a5fb",
      ],
      type: "block",
    };

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    send(sock, { type: "object", object: block });

    const messages = await collectMessages(sock, 5000);

    const errorMsg = messages.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_BLOCK_COINBASE,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 10_000);

  // ── Testcase 11: Double spending within a block ─────────
  // Grader transcript (same connection, two parts):
  //   Part A: Send block with coinbase tx, verify stored
  //   Part B: Send block that double-spends the coinbase, expect INVALID_TX_OUTPOINT
  test("Double spending within a block", async () => {
    const blockA = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771184555,
      miner: "grader",
      nonce: "36a150836fc4a7dbfa40d64c9cf616c0d4a3ac18e6bf46fbc2514ea45bdaaf5c",
      note: "This block has a coinbase transaction",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: ["96339757c036018f3f272b2d8128248241e6ecfe0f9047d7f2cfe2fde3df267a"],
      type: "block",
    };
    const blockAId = "00000000556048ae26893c5bd08e9539b2f62ca5b5847b87a6c8e9800f0da467";

    const blockB = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771188155,
      miner: "grader",
      nonce: "a2275563b730b184200896bff2c8b9bb88206e21c64a67659dcffead83003c27",
      note: "This block spends coinbase transaction twice",
      previd: "00000000556048ae26893c5bd08e9539b2f62ca5b5847b87a6c8e9800f0da467",
      txids: [
        "0308131405b190db3c94052b9b7185a62538010c8e5298cb104e31edc5a68877",
        "d38db64554dcb26d5246ec7f4ea365b654f1bb1710a9c6615e8053cea11ca547",
      ],
      type: "block",
    };

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send valid block with coinbase, wait, then request it back
    send(sock, { type: "object", object: blockA });

    send(sock, { type: "getobject", objectid: blockAId });

    const msgsA = await collectMessages(sock, 5000);

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(blockAId);

    send(sock, { type: "object", object: blockB });

    const msgsB = await collectMessages(sock, 5000);

    const errorMsg = msgsB.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 25_000);

  // ── Testcase 12: Double spend in successive blocks ─────
  // Grader transcript (same connection, three parts):
  //   Part A: Send block with coinbase tx, verify stored
  //   Part B: Send block spending that coinbase once , verify stored
  //   Part C: Send block spending same coinbase again ,expect INVALID_TX_OUTPOINT
  test("Double spend in successive blocks", async () => {
    const blockA = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771191755,
      miner: "grader",
      nonce: "dd8c12b37231a171ce8909f379bc86b7fb3be1599eec863f7d221d967f8bfb47",
      note: "This block has a coinbase transaction",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: ["c825462af622841b4be6c023c32eecc0a723be845ee867efee41debe24a5fb8c"],
      type: "block",
    };
    const blockAId = "000000002285ac3f587def52a366014f5d2e2ecc38e6527a14c11f912c7fa9fc";

    const blockB = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771195355,
      miner: "grader",
      nonce: "4875ff49c105353fefd45057f42790c4efd727714d90074970d4e8458e34b467",
      note: "This block spends coinbase transaction once (it is valid)",
      previd: "000000002285ac3f587def52a366014f5d2e2ecc38e6527a14c11f912c7fa9fc",
      txids: ["01d62f3494326ff8f0541b9d0d06395be32d6761d919be4ae311bc5172ba80d7"],
      type: "block",
    };
    const blockBId = "0000000075e0bff767796c8b3beb771aeda55c2d18b947ab13bb01334f4038ed";

    const blockC = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771198955,
      miner: "grader",
      nonce: "65888dc80eb6b0b12879e47c68c49a5e9215bcdf1677825d4fcc1aa92b650b44",
      note: "This block spends coinbase transaction again (it is invalid)",
      previd: "0000000075e0bff767796c8b3beb771aeda55c2d18b947ab13bb01334f4038ed",
      txids: ["ddb6a2d270a34f5007237d4f34814b48262c26ef94cc0b9245d8ca1dafbc4070"],
      type: "block",
    };

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send block with coinbase tx, wait, then request it back
    send(sock, { type: "object", object: blockA });

    send(sock, { type: "getobject", objectid: blockAId });

    const msgsA = await collectMessages(sock, 5000);

    const objectMsgA = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockAId,
    );
    expect(objectMsgA).toBeDefined();
    expect(oid(objectMsgA.object)).toBe(blockAId);

    // Part B: Send block spending coinbase once (valid), wait, then request it back
    send(sock, { type: "object", object: blockB });

    send(sock, { type: "getobject", objectid: blockBId });

    const msgsB = await collectMessages(sock, 5000);

    const objectMsgB = msgsB.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === blockBId,
    );
    expect(objectMsgB).toBeDefined();
    expect(oid(objectMsgB.object)).toBe(blockBId);

    send(sock, { type: "object", object: blockC });

    const msgsC = await collectMessages(sock, 5000);

    let errorMsg = msgsC.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 35_000);

  // ── Testcase 13: Block with transaction that spends UTXO that doesn't exist ──
  // Grader transcript (same connection, two parts):
  //   Part A: Send standalone coinbase tx, then getobject for it — expect it back
  //   Part B: Send block whose tx spends a UTXO not in any previous block — expect INVALID_TX_OUTPOINT
  test("Block with transaction that spends UTXO that doesn't exist", async () => {
    const coinbaseTx = {
      height: 1,
      outputs: [
        {
          pubkey: "e39b7117f6bd94dd174f96556fc0850f564b873e8b873e507556493a200176b3",
          value: 50000000000000,
        },
      ],
      type: "transaction",
    };
    const coinbaseTxId = "e5ed65492e6b9fc7bdeaaf3ae1b7aa1d850ffec4cd9903067e01496ccef80d8b";

    const block = {
      T: "00000000abc00000000000000000000000000000000000000000000000000000",
      created: 1771198955,
      miner: "grader",
      nonce: "c70416fef43c0e191778bb04df0945c100db9241d640ac5e1c2b4a9562246f94",
      note: "This block spends a coinbase transaction not in its prev blocks",
      previd: "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
      txids: ["c623a2700681dbc7a9a31bcd1d5128777adb107ad0f143d9367ee0dbb5a6bd0f"],
      type: "block",
    };

    const sock = await connect();

    send(sock, { agent: "Grader 1", type: "hello", version: "0.10.0" });

    // Part A: Send standalone coinbase tx, then request it back
    send(sock, { type: "object", object: coinbaseTx });

    send(sock, { type: "getobject", objectid: coinbaseTxId });

    const msgsA = await collectMessages(sock, 5000);

    const objectMsg = msgsA.find(
      (m: any) => m.type === "object" && m.object && oid(m.object) === coinbaseTxId,
    );
    expect(objectMsg).toBeDefined();
    expect(oid(objectMsg.object)).toBe(coinbaseTxId);

    // Part B: Send block whose tx spends a UTXO not in any previous block's UTXO set
    send(sock, { type: "object", object: block });

    const msgsB = await collectMessages(sock, 5000);

    let errorMsg = msgsB.find(
      (m: any) => m.type === "error" && m.name === ErrorCode.INVALID_TX_OUTPOINT,
    );
    expect(errorMsg).toBeDefined();

    sock.destroy();
  }, 25_000);
});
