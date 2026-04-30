import * as ed from "@noble/ed25519";
import { bytesToHex } from "@noble/hashes/utils.js";
import { GENESIS_BLOCK_ID, BLOCK_REWARD } from "@/protocol/types";
import { buildBlock, coinbase, oid } from "../test_helpers";

const SK = new Uint8Array(Buffer.from("01".repeat(32), "hex"));
const PK = bytesToHex(await ed.getPublicKeyAsync(SK));

//  Test 1a – Blockchain pointing to unavailable block
export const TC1A = (() => {
  const FAKE_PARENT = "000000000000000000000000000000000000000000000000000000000000dead";

  const block = buildBlock({
    created: 1771162955,
    miner: "grader",
    nonce: "0".repeat(63) + "1",
    note: "Points to unavailable block",
    previd: FAKE_PARENT,
    txids: [],
  });

  return { BLOCK: block, BLOCK_ID: oid(block) };
})();

//  Test 1b – Non-increasing timestamp
export const TC1B = (() => {
  const block = buildBlock({
    created: 1771159355, // same as genesis
    miner: "grader",
    nonce: "0".repeat(63) + "2",
    note: "Non-increasing timestamp",
    previd: GENESIS_BLOCK_ID,
    txids: [],
  });

  return { BLOCK: block, BLOCK_ID: oid(block) };
})();

//  Test 1c – Block in the future (year 2077)
export const TC1C = (() => {
  const block = buildBlock({
    created: 2281468800,
    miner: "grader",
    nonce: "0".repeat(63) + "3",
    note: "Block from the future",
    previd: GENESIS_BLOCK_ID,
    txids: [],
  });

  return { BLOCK: block, BLOCK_ID: oid(block) };
})();

//  Test 1e – Incorrect coinbase height
export const TC1E = (() => {
  const cb = coinbase(99, PK, BLOCK_REWARD);
  const cbId = oid(cb);

  const block = buildBlock({
    created: 1771162955,
    miner: "grader",
    nonce: "0".repeat(63) + "6",
    note: "Coinbase has wrong height",
    previd: GENESIS_BLOCK_ID,
    txids: [cbId],
  });

  return {
    CB: cb,
    CB_ID: cbId,
    BLOCK: block,
    BLOCK_ID: oid(block),
  };
})();

//  Test 2 – Longest chain (fork at genesis, depth 0)
// Chain A: genesis → A1
// Chain B: genesis → B1 → B2 → B3  (reorg depth 1)
export const TC2 = (() => {
  const cb1 = coinbase(1, PK, BLOCK_REWARD);
  const cb2 = coinbase(2, PK, BLOCK_REWARD);
  const cb3 = coinbase(3, PK, BLOCK_REWARD);

  const a1 = buildBlock({
    created: 1771162955,
    miner: "grader",
    nonce: "0".repeat(62) + "a1",
    note: "Chain A block 1",
    previd: GENESIS_BLOCK_ID,
    txids: [oid(cb1)],
  });

  const b1 = buildBlock({
    created: 1771162956,
    miner: "grader",
    nonce: "0".repeat(62) + "b1",
    note: "Chain B block 1",
    previd: GENESIS_BLOCK_ID,
    txids: [oid(cb1)],
  });

  const b2 = buildBlock({
    created: 1771162957,
    miner: "grader",
    nonce: "0".repeat(62) + "b2",
    note: "Chain B block 2",
    previd: oid(b1),
    txids: [oid(cb2)],
  });

  const b3 = buildBlock({
    created: 1771162958,
    miner: "grader",
    nonce: "0".repeat(62) + "b3",
    note: "Chain B block 3",
    previd: oid(b2),
    txids: [oid(cb3)],
  });

  return {
    CB1: cb1,
    CB1_ID: oid(cb1),
    CB2: cb2,
    CB2_ID: oid(cb2),
    CB3: cb3,
    CB3_ID: oid(cb3),
    A1: a1,
    A1_ID: oid(a1),
    B1: b1,
    B1_ID: oid(b1),
    B2: b2,
    B2_ID: oid(b2),
    B3: b3,
    B3_ID: oid(b3),
  };
})();

//  Test 4 – Non-increasing timestamp chain (3 blocks)
// Chain: genesis → N1 → N2 → N3
// All 3 blocks have timestamp 1671185419 (< genesis 1771159355).
// N3 sent first (triggers parent fetch), then N2, then N1.
// Every block in the chain must emit INVALID_BLOCK_TIMESTAMP.
export const TC4 = (() => {
  const n1 = buildBlock({
    created: 1671185419,
    miner: "grader",
    nonce: "e1f93579f1c54185a6020f17572db01cc8d3de24a3371aa54956f021402d5b94",
    note: "First block",
    previd: GENESIS_BLOCK_ID,
    txids: ["f2f43661c91b654d76eeea37f13fdc39f2a4b18c7045286bb96a069e06d86f42"],
  });

  const n2 = buildBlock({
    created: 1671185419,
    miner: "grader",
    nonce: "09c7e66edbb6af849b75a28400c30a0bc1c972da465b916bcfa2dece494222aa",
    note: "Second block",
    previd: oid(n1),
    txids: [
      "9cf97338a29337abd6da6d88b6401b710b452c1e858dde25dcf52a0e27e85b1c",
      "130f2678ab736a587ffede1d88e181a77fa51450c17573ab2231fadc67bc9002",
    ],
  });

  const n3 = buildBlock({
    created: 1671185419,
    miner: "grader",
    nonce: "10b237c3471b4aa717c98420800ba9b4799f563c568f46f1ea08eb9070b1b70b",
    note: "Third block",
    previd: oid(n2),
    txids: [
      "9fc20d18f1da1f4424d7f7cdca752e267fcd92881471c7a09c20e6b0373cf616",
      "4b8da0a849c171e848cd6d9f6553fb4bd04f70ab8ca5a11cede301e4d19718b4",
    ],
  });

  return { N1: n1, N1_ID: oid(n1), N2: n2, N2_ID: oid(n2), N3: n3, N3_ID: oid(n3) };
})();

//  Test 5 – Unavailable parent (must emit UNFINDABLE_OBJECT)
// Block points to previd that does not exist.
// Node should request it, time out, emit UNFINDABLE_OBJECT.
export const TC5 = (() => {
  const block = buildBlock({
    created: 1771233150,
    miner: "grader",
    nonce: "a36b34db7826e5a57ea7320fcb0a80c65d69fe5c50d276a6ed4f38e93fa193ec",
    note: "Previous block unavailable",
    previd: "000000004b688f3c571186076b3e36c81dee93a29ff635f4c801ff373e05ec8f",
    txids: [],
  });

  return { BLOCK: block, BLOCK_ID: oid(block) };
})();

//  Test 6a – Invalid PoW / nonexistent parent
// Block points to previd that does not exist (not in chain,
// not in any peer's store). Node should request it, time out,
// and emit UNFINDABLE_OBJECT (or INVALID_BLOCK_POW / INVALID_FORMAT).
export const TC6A = (() => {
  const block = buildBlock({
    created: 1771239763,
    miner: "grader",
    nonce: "d644e06c1334f62e2abd073a65a0ab37e2dfd47a1df86c10682d4f94559e43f1",
    note: "Third block",
    previd: "908e5fa37b61ed2fab5c4de7d38f21ef02ef5dbe7f976cfe12b9cb8326592e86",
    txids: [
      "9fc20d18f1da1f4424d7f7cdca752e267fcd92881471c7a09c20e6b0373cf616",
      "4b8da0a849c171e848cd6d9f6553fb4bd04f70ab8ca5a11cede301e4d19718b4",
    ],
  });

  return { BLOCK: block, BLOCK_ID: oid(block) };
})();

//  Test 6b – Chain on top of block with unavailable parent
// Same invalid block as TC6A, plus a SECOND block that chains
// on it. When the root's parent is unfindable, the entire
// sub-chain must be rejected. No gossip for either block.
export const TC6B = (() => {
  const second = buildBlock({
    created: 1771239764,
    miner: "grader",
    nonce: "e744f06d2445a73f3cbe184beb1c26c38e3ea47b2ea97d21793e4a0566f54f2a",
    note: "Fourth block",
    previd: TC6A.BLOCK_ID,
    txids: [],
  });

  return { SECOND: second, SECOND_ID: oid(second) };
})();

//  Test 7 – Longest chain extension (30 valid blocks)
// 30 blocks with valid PoW that chain on genesis.
// Each block has timestamp > parent, correct nonce format.
// Verifies: chain walk returns full length, tip matches.
const TC7_RAW: Array<{
  created: number;
  nonce: string;
  note: string;
}> = [
  {
    created: 1776903359,
    nonce: "00000000000000000000000000000000000000000000000000000000b9af62af",
    note: "Long chain block 1",
  },
  {
    created: 1776906928,
    nonce: "0000000000000000000000000000000000000000000000000000000037ef3af1",
    note: "Long chain block 2",
  },
  {
    created: 1776907667,
    nonce: "00000000000000000000000000000000000000000000000003000000d2413165",
    note: "Long chain block 3",
  },
  {
    created: 1776907939,
    nonce: "0000000000000000000000000000000000000000000000000100000061accf59",
    note: "Long chain block 4",
  },
  {
    created: 1776909755,
    nonce: "000000000000000000000000000000000000000000000000010000001e68c33e",
    note: "Long chain block 5",
  },
  {
    created: 1776912630,
    nonce: "00000000000000000000000000000000000000000000000003000000029bd62c",
    note: "Long chain block 6",
  },
  {
    created: 1776912699,
    nonce: "000000000000000000000000000000000000000000000000000000009f17f861",
    note: "Long chain block 7",
  },
  {
    created: 1776913600,
    nonce: "00000000000000000000000000000000000000000000000001000000b94f4ba3",
    note: "Long chain block 8",
  },
  {
    created: 1776917075,
    nonce: "000000000000000000000000000000000000000000000000000000001a7520d0",
    note: "Long chain block 9",
  },
  {
    created: 1776919173,
    nonce: "0000000000000000000000000000000000000000000000000000000020bb6e3e",
    note: "Long chain block 10",
  },
  {
    created: 1776919594,
    nonce: "00000000000000000000000000000000000000000000000001000000f2509c0c",
    note: "Long chain block 11",
  },
  {
    created: 1776922852,
    nonce: "00000000000000000000000000000000000000000000000001000000549d6990",
    note: "Long chain block 12",
  },
  {
    created: 1776924334,
    nonce: "0000000000000000000000000000000000000000000000000100000057f8777b",
    note: "Long chain block 13",
  },
  {
    created: 1776926903,
    nonce: "000000000000000000000000000000000000000000000000020000002715feba",
    note: "Long chain block 14",
  },
  {
    created: 1776927925,
    nonce: "00000000000000000000000000000000000000000000000001000000614c1a06",
    note: "Long chain block 15",
  },
  {
    created: 1776930976,
    nonce: "00000000000000000000000000000000000000000000000004000000ace36a81",
    note: "Long chain block 16",
  },
  {
    created: 1776931135,
    nonce: "000000000000000000000000000000000000000000000000000000008e97356b",
    note: "Long chain block 17",
  },
  {
    created: 1776931734,
    nonce: "000000000000000000000000000000000000000000000000000000006042d466",
    note: "Long chain block 18",
  },
  {
    created: 1776934555,
    nonce: "00000000000000000000000000000000000000000000000002000000ff137348",
    note: "Long chain block 19",
  },
  {
    created: 1776935638,
    nonce: "0000000000000000000000000000000000000000000000000000000083683b5c",
    note: "Long chain block 20",
  },
  {
    created: 1776937955,
    nonce: "000000000000000000000000000000000000000000000000020000007f383bb0",
    note: "Long chain block 21",
  },
  {
    created: 1776939060,
    nonce: "00000000000000000000000000000000000000000000000000000000125c2419",
    note: "Long chain block 22",
  },
  {
    created: 1776941973,
    nonce: "00000000000000000000000000000000000000000000000001000000cabc93bb",
    note: "Long chain block 23",
  },
  {
    created: 1776944500,
    nonce: "00000000000000000000000000000000000000000000000000000000a1e4018c",
    note: "Long chain block 24",
  },
  {
    created: 1776947860,
    nonce: "000000000000000000000000000000000000000000000000000000000961c08a",
    note: "Long chain block 25",
  },
  {
    created: 1776950817,
    nonce: "00000000000000000000000000000000000000000000000002000000f78ac1c7",
    note: "Long chain block 26",
  },
  {
    created: 1776953573,
    nonce: "000000000000000000000000000000000000000000000000020000006a81b96b",
    note: "Long chain block 27",
  },
  {
    created: 1776955194,
    nonce: "00000000000000000000000000000000000000000000000002000000c420fc95",
    note: "Long chain block 28",
  },
  {
    created: 1776957373,
    nonce: "00000000000000000000000000000000000000000000000002000000121f1ae9",
    note: "Long chain block 29",
  },
  {
    created: 1776958147,
    nonce: "00000000000000000000000000000000000000000000000001000000599e3ddf",
    note: "Long chain block 30",
  },
];

export const TC7 = (() => {
  let prev: string = GENESIS_BLOCK_ID;
  const blocks: Array<{ id: string; block: unknown }> = [];

  for (const r of TC7_RAW) {
    const block = buildBlock({
      created: r.created,
      miner: "grader",
      nonce: r.nonce,
      note: r.note,
      previd: prev,
      txids: [],
    });
    const id = oid(block);
    blocks.push({ id, block });
    prev = id;
  }

  const map = new Map(blocks.map((b) => [b.id, b.block]));
  return { BLOCKS: blocks, MAP: map, TIP_ID: blocks[blocks.length - 1]!.id };
})();

//  Test 3 – Deep reorg (fork at A1, depth 2)
// Chain A: genesis → A1 → A2 → A3  (height 3)
// Chain B: genesis → A1 → B1 → B2 → B3 → B4  (height 4)
// Common ancestor: A1. Abandons A2, A3. Adopts B1-B4.
export const TC3 = (() => {
  const cb1 = coinbase(1, PK, BLOCK_REWARD);
  const cb2 = coinbase(2, PK, BLOCK_REWARD);
  const cb3 = coinbase(3, PK, BLOCK_REWARD);
  const cb4 = coinbase(4, PK, BLOCK_REWARD);
  const cb5 = coinbase(5, PK, BLOCK_REWARD);

  const a1 = buildBlock({
    created: 1771162955,
    miner: "grader",
    nonce: "0".repeat(62) + "c1",
    note: "Chain A block 1",
    previd: GENESIS_BLOCK_ID,
    txids: [oid(cb1)],
  });

  const a2 = buildBlock({
    created: 1771162956,
    miner: "grader",
    nonce: "0".repeat(62) + "c2",
    note: "Chain A block 2",
    previd: oid(a1),
    txids: [oid(cb2)],
  });

  const a3 = buildBlock({
    created: 1771162957,
    miner: "grader",
    nonce: "0".repeat(62) + "c3",
    note: "Chain A block 3",
    previd: oid(a2),
    txids: [oid(cb3)],
  });

  const b1 = buildBlock({
    created: 1771162958,
    miner: "grader",
    nonce: "0".repeat(62) + "d1",
    note: "Chain B block 1 (forks from A1)",
    previd: oid(a1),
    txids: [oid(cb2)],
  });

  const b2 = buildBlock({
    created: 1771162959,
    miner: "grader",
    nonce: "0".repeat(62) + "d2",
    note: "Chain B block 2",
    previd: oid(b1),
    txids: [oid(cb3)],
  });

  const b3 = buildBlock({
    created: 1771162960,
    miner: "grader",
    nonce: "0".repeat(62) + "d3",
    note: "Chain B block 3",
    previd: oid(b2),
    txids: [oid(cb4)],
  });

  const b4 = buildBlock({
    created: 1771162961,
    miner: "grader",
    nonce: "0".repeat(62) + "d4",
    note: "Chain B block 4",
    previd: oid(b3),
    txids: [oid(cb5)],
  });

  return {
    CB1: cb1,
    CB1_ID: oid(cb1),
    CB2: cb2,
    CB2_ID: oid(cb2),
    CB3: cb3,
    CB3_ID: oid(cb3),
    CB4: cb4,
    CB4_ID: oid(cb4),
    CB5: cb5,
    CB5_ID: oid(cb5),
    A1: a1,
    A1_ID: oid(a1),
    A2: a2,
    A2_ID: oid(a2),
    A3: a3,
    A3_ID: oid(a3),
    B1: b1,
    B1_ID: oid(b1),
    B2: b2,
    B2_ID: oid(b2),
    B3: b3,
    B3_ID: oid(b3),
    B4: b4,
    B4_ID: oid(b4),
  };
})();

export const P4_GLOBAL_STORE = new Map<string, unknown>([
  // TC1E
  [TC1E.CB_ID, TC1E.CB],
  [TC1E.BLOCK_ID, TC1E.BLOCK],

  // TC2
  [TC2.CB1_ID, TC2.CB1],
  [TC2.CB2_ID, TC2.CB2],
  [TC2.CB3_ID, TC2.CB3],
  [TC2.A1_ID, TC2.A1],
  [TC2.B1_ID, TC2.B1],
  [TC2.B2_ID, TC2.B2],
  [TC2.B3_ID, TC2.B3],

  // TC3 (The Deep Reorg)
  [TC3.CB1_ID, TC3.CB1],
  [TC3.CB2_ID, TC3.CB2],
  [TC3.CB3_ID, TC3.CB3],
  [TC3.CB4_ID, TC3.CB4],
  [TC3.CB5_ID, TC3.CB5],
  [TC3.A1_ID, TC3.A1],
  [TC3.A2_ID, TC3.A2],
  [TC3.A3_ID, TC3.A3],
  [TC3.B1_ID, TC3.B1],
  [TC3.B2_ID, TC3.B2],
  [TC3.B3_ID, TC3.B3],
  [TC3.B4_ID, TC3.B4],

  // TC4 – Non-increasing chain
  [TC4.N1_ID, TC4.N1],
  [TC4.N2_ID, TC4.N2],
  [TC4.N3_ID, TC4.N3],

  // TC5 – Unavailable parent
  [TC5.BLOCK_ID, TC5.BLOCK],

  // TC6 – Chain on unavailable parent
  [TC6A.BLOCK_ID, TC6A.BLOCK],

  [TC6B.SECOND_ID, TC6B.SECOND],

  // TC7 – Longest chain (30 valid blocks)
  ...Array.from(TC7.MAP),
]);
