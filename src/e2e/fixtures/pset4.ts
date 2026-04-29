import * as ed from "@noble/ed25519";
import { bytesToHex } from "@noble/hashes/utils.js";
import { GENESIS_BLOCK_ID, BLOCK_REWARD } from "@/protocol/types";
import { buildBlock, coinbase, oid } from "../test_helpers";

// ── Key pair ────────────────────────────────────────────

const SK = new Uint8Array(Buffer.from("01".repeat(32), "hex"));
const PK = bytesToHex(await ed.getPublicKeyAsync(SK));

// ═══════════════════════════════════════════════════════
//  Test 1a – Blockchain pointing to unavailable block
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
//  Test 1b – Non-increasing timestamp
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
//  Test 1c – Block in the future (year 2077)
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
//  Test 1d – Fake genesis (wrong ID)
// ═══════════════════════════════════════════════════════
// Inline in test – just a genesis-like block with different note.

// ═══════════════════════════════════════════════════════
//  Test 1e – Incorrect coinbase height
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
//  Test 2 – Longest chain (fork at genesis, depth 0)
// ═══════════════════════════════════════════════════════
// Chain A: genesis → A1
// Chain B: genesis → B1 → B2 → B3  (reorg depth 1)
// ═══════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════
//  Test 3 – Deep reorg (fork at A1, depth 2)
// ═══════════════════════════════════════════════════════
// Chain A: genesis → A1 → A2 → A3  (height 3)
// Chain B: genesis → A1 → B1 → B2 → B3 → B4  (height 4)
// Common ancestor: A1. Abandons A2, A3. Adopts B1-B4.
// ═══════════════════════════════════════════════════════

export const TC3 = (() => {
  const cb1 = coinbase(1, PK, BLOCK_REWARD);
  const cb2 = coinbase(2, PK, BLOCK_REWARD);
  const cb3 = coinbase(3, PK, BLOCK_REWARD);
  const cb4 = coinbase(4, PK, BLOCK_REWARD);
  const cb5 = coinbase(5, PK, BLOCK_REWARD);

  // Chain A
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

  // Chain B branches from A1
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

// ═══════════════════════════════════════════════════════
//  GLOBAL_STORE
// ═══════════════════════════════════════════════════════

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
]);
