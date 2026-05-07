import * as ed from "@noble/ed25519";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { GENESIS_BLOCK, GENESIS_BLOCK_ID, BLOCK_REWARD, ObjectType } from "@/protocol/types";
import { buildBlock, buildSpend, coinbase, nonce, oid } from "../test_helpers";

// ── Key pairs ───────────────────────────────────────────

const SK1 = new Uint8Array(Buffer.from("01".repeat(32), "hex"));
export const PK1 = bytesToHex(await ed.getPublicKeyAsync(SK1));

const SK2 = new Uint8Array(Buffer.from("02".repeat(32), "hex"));
export const PK2 = bytesToHex(await ed.getPublicKeyAsync(SK2));

// ── Test 1a – Transaction with duplicate inputs ──────────
// Code throws INVALID_TX_OUTPOINT (consistent with pset3 double-spend).

export const TC1A = (() => {
  // Coinbase to establish a prevTx in the object manager.
  const cbSetup = coinbase(100, PK1, BLOCK_REWARD);
  const cbSetupId = oid(cbSetup);

  // Two inputs share the same outpoint.  Signatures are dummy —
  // checkDuplicateInputs fires before verifySignatures reaches them.
  const dupInputsTx = {
    type: ObjectType.TRANSACTION,
    inputs: [
      { outpoint: { txid: cbSetupId, index: 0 }, sig: "00".repeat(64) },
      { outpoint: { txid: cbSetupId, index: 0 }, sig: "00".repeat(64) },
    ],
    outputs: [{ pubkey: PK2, value: BLOCK_REWARD }],
  };

  return { CB_SETUP: cbSetup, CB_SETUP_ID: cbSetupId, DUP_INPUTS_TX: dupInputsTx };
})();

// ── Test 1b – Block with > 128 character note ───────────
// Spec: Grader 1 must receive INVALID_FORMAT.

export const TC1B = (() => {
  const block = buildBlock({
    created: 1771162955,
    miner: "grader",
    nonce: nonce(0xa),
    note: "a".repeat(129),
    previd: GENESIS_BLOCK_ID,
    txids: [],
  });

  return { BLOCK: block, BLOCK_ID: oid(block) };
})();

// ── Shared chain ────────────────────────────────────────
// genesis → B1 → B2_EXTENDED → B3  (height 3)
//
// B1  : coinbase CB1 (to PK1, value BLOCK_REWARD)
// B2_EXTENDED : coinbase CB2 (to PK2, value BLOCK_REWARD)
//             + regular tx TX_EXTRA (spends CB1 → PK1)
// B3  : coinbase CB3 (to PK2, value BLOCK_REWARD)
//
// UTXO at height 3:  CB3 (PK2, unspent), TX_EXTRA output (PK1, unspent),
//                     plus CB2 (PK2) that is also unspent.

export const CHAIN = await (async () => {
  const cb1 = coinbase(1, PK1, BLOCK_REWARD);
  const cb1Id = oid(cb1);

  const b1 = buildBlock({
    created: 1771162955,
    miner: "grader",
    nonce: nonce(0x1),
    note: "Chain block 1",
    previd: GENESIS_BLOCK_ID,
    txids: [cb1Id],
  });

  const txExtra = await buildSpend(cb1Id, PK1, BLOCK_REWARD - 1, SK1);
  const txExtraId = oid(txExtra);

  const cb2 = coinbase(2, PK2, BLOCK_REWARD);
  const cb2Id = oid(cb2);

  const b2Extended = buildBlock({
    created: 1771166555,
    miner: "grader",
    nonce: nonce(0x2),
    note: "Chain block 2 (extended)",
    previd: oid(b1),
    txids: [cb2Id, txExtraId],
  });

  const cb3 = coinbase(3, PK2, BLOCK_REWARD);
  const cb3Id = oid(cb3);

  const b3 = buildBlock({
    created: 1771170155,
    miner: "grader",
    nonce: nonce(0x3),
    note: "Chain block 3",
    previd: oid(b2Extended),
    txids: [cb3Id],
  });

  return {
    CB1: cb1,
    CB1_ID: cb1Id,
    B1: b1,
    B1_ID: oid(b1),
    TX_EXTRA: txExtra,
    TX_EXTRA_ID: txExtraId,
    CB2: cb2,
    CB2_ID: cb2Id,
    B2_EXTENDED: b2Extended,
    B2_EXTENDED_ID: oid(b2Extended),
    CB3: cb3,
    CB3_ID: cb3Id,
    B3: b3,
    B3_ID: oid(b3),
  };
})();

// ── Test 2 – Valid transaction spending two outputs ──────
// Spends CB2 output (PK2) and TX_EXTRA output (PK1).
// Two inputs with different public keys.
// Grader 2 must receive the transaction via getobject.

export const TC2 = await (async () => {
  const spendBoth = {
    type: ObjectType.TRANSACTION as string,
    inputs: [
      { outpoint: { txid: CHAIN.CB2_ID, index: 0 }, sig: null as string | null },
      { outpoint: { txid: CHAIN.TX_EXTRA_ID, index: 0 }, sig: null as string | null },
    ],
    outputs: [{ pubkey: PK1, value: BLOCK_REWARD * 2 - 2 }],
  };

  // Both inputs sign the same canonicalized message (all sigs nulled).
  const unsignedMsg = canonicalize({
    ...spendBoth,
    inputs: spendBoth.inputs.map((i: any) => ({ ...i, sig: null })),
  })!;
  const msgBytes = new Uint8Array(Buffer.from(unsignedMsg, "utf-8"));
  const sigForPk2 = bytesToHex(await ed.signAsync(msgBytes, SK2)); // CB2 is PK2
  const sigForPk1 = bytesToHex(await ed.signAsync(msgBytes, SK1)); // TX_EXTRA output is PK1

  spendBoth.inputs[0]!.sig = sigForPk2;
  spendBoth.inputs[1]!.sig = sigForPk1;

  return { SPEND_BOTH: spendBoth, SPEND_BOTH_ID: oid(spendBoth) };
})();

// ── Test 3b – Valid transaction against mempool ─────────
// Spends CB3 output (PK2). Should appear in mempool.

export const TC3_VALID_TX = await (async () => {
  const tx = await buildSpend(CHAIN.CB3_ID, PK1, BLOCK_REWARD - 1, SK2);
  return { TX: tx, TX_ID: oid(tx) };
})();

// ── Test 3c – Invalid transaction (double-spends CB3) ───
// Reuses same CB3 outpoint → should NOT appear in mempool.

export const TC3_INVALID_TX = await (async () => {
  const tx = await buildSpend(CHAIN.CB3_ID, PK1, BLOCK_REWARD - 2, SK2);
  return { TX: tx, TX_ID: oid(tx) };
})();

// ── Test 3d – Standalone coinbase ────────────────────────
// Should be stored but NOT appear in mempool.

export const TC3_COINBASE_TX = (() => {
  const cb = coinbase(999, PK1, BLOCK_REWARD);
  return { TX: cb, TX_ID: oid(cb) };
})();

// ── Test 3e – Reorg chain ───────────────────────────────
// Old chain:  genesis → B1 → B2_EXTENDED → B3 (height 3)
// New chain:  genesis → B1 → B2_ALT → B3_ALT → B4_ALT (height 4)
// B2_EXTENDED & B3 are abandoned → TX_EXTRA re-validated & added to mempool.
// Existing mempool txs (SPEND_BOTH, VALID_TX) become invalid
// (their inputs no longer exist in new UTXO) → removed.

export const TC3_REORG = await (async () => {
  const cb2Alt = coinbase(2, PK1, BLOCK_REWARD);
  const cb2AltId = oid(cb2Alt);

  const b2Alt = buildBlock({
    created: 1771173755,
    miner: "grader",
    nonce: nonce(0x4),
    note: "Fork block 2",
    previd: CHAIN.B1_ID,
    txids: [cb2AltId],
  });

  const cb3Alt = coinbase(3, PK2, BLOCK_REWARD);
  const cb3AltId = oid(cb3Alt);

  const b3Alt = buildBlock({
    created: 1771177355,
    miner: "grader",
    nonce: nonce(0x5),
    note: "Fork block 3",
    previd: oid(b2Alt),
    txids: [cb3AltId],
  });

  const cb4Alt = coinbase(4, PK1, BLOCK_REWARD);
  const cb4AltId = oid(cb4Alt);

  const b4Alt = buildBlock({
    created: 1771180955,
    miner: "grader",
    nonce: nonce(0x6),
    note: "Fork block 4",
    previd: oid(b3Alt),
    txids: [cb4AltId],
  });

  return {
    CB2_ALT: cb2Alt,
    CB2_ALT_ID: cb2AltId,
    B2_ALT: b2Alt,
    B2_ALT_ID: oid(b2Alt),
    CB3_ALT: cb3Alt,
    CB3_ALT_ID: cb3AltId,
    B3_ALT: b3Alt,
    B3_ALT_ID: oid(b3Alt),
    CB4_ALT: cb4Alt,
    CB4_ALT_ID: cb4AltId,
    B4_ALT: b4Alt,
    B4_ALT_ID: oid(b4Alt),
  };
})();

// ── Test 3f – Tx spending from dead fork (equal-height rival) ───
// Scenario: fork A is tip, then a valid tx spends from fork A's coinbase.
// After building fork A (B3) as tip, we build a rival B3_DEAD at same height
// but DON'T send it (it stays in the store for getobject). The tx spends CB3
// and should appear in mempool. Then we send B3_DEAD (same height) — no reorg.
// New tx spends from B3_DEAD's coinbase — should NOT enter mempool
// because B3 is still tip.

export const TC3_DEAD_FORK = await (async () => {
  const cbDead = coinbase(3, PK1, BLOCK_REWARD);
  const cbDeadId = oid(cbDead);

  const b3Dead = buildBlock({
    created: 1771172000,
    miner: "grader",
    nonce: nonce(0xf),
    note: "Dead fork block 3",
    previd: CHAIN.B2_EXTENDED_ID,
    txids: [cbDeadId],
  });

  // B4 extends B3 (fork A), can reorg over B3_DEAD's fork
  const cb4 = coinbase(4, PK2, BLOCK_REWARD);
  const cb4Id = oid(cb4);
  const b4 = buildBlock({
    created: 1771175600,
    miner: "grader",
    nonce: nonce(0x4),
    note: "Fork A block 4",
    previd: CHAIN.B3_ID,
    txids: [cb4Id],
  });

  // B5 at h=5 to beat B4_ALT at h=4
  const cb5 = coinbase(5, PK1, BLOCK_REWARD);
  const cb5Id = oid(cb5);
  const b5 = buildBlock({
    created: 1771179200,
    miner: "grader",
    nonce: nonce(0x5),
    note: "Fork A block 5",
    previd: oid(b4),
    txids: [cb5Id],
  });

  // Tx that spends B2_EXTENDED's coinbase (fork A only, NOT available on fork B)
  const txForkA = await buildSpend(CHAIN.CB2_ID, PK1, BLOCK_REWARD - 1, SK2);

  return {
    CB_DEAD: cbDead,
    CB_DEAD_ID: cbDeadId,
    B3_DEAD: b3Dead,
    B3_DEAD_ID: oid(b3Dead),
    B4_DEAD: b4,
    B4_DEAD_ID: oid(b4),
    B5_DEAD: b5,
    B5_DEAD_ID: oid(b5),
    CB4_DEAD: cb4,
    CB4_DEAD_ID: cb4Id,
    CB5_DEAD: cb5,
    CB5_DEAD_ID: cb5Id,
    TX_FORK_A: txForkA,
    TX_FORK_A_ID: oid(txForkA),
  };
})();

// ── Global object store (serves getobject replies during tests) ──

export const P5_GLOBAL_STORE = new Map<string, unknown>([
  [GENESIS_BLOCK_ID, GENESIS_BLOCK],
  // TC1A
  [TC1A.CB_SETUP_ID, TC1A.CB_SETUP],
  // TC1B
  [TC1B.BLOCK_ID, TC1B.BLOCK],
  // CHAIN
  [CHAIN.CB1_ID, CHAIN.CB1],
  [CHAIN.CB2_ID, CHAIN.CB2],
  [CHAIN.CB3_ID, CHAIN.CB3],
  [CHAIN.TX_EXTRA_ID, CHAIN.TX_EXTRA],
  [CHAIN.B1_ID, CHAIN.B1],
  [CHAIN.B2_EXTENDED_ID, CHAIN.B2_EXTENDED],
  [CHAIN.B3_ID, CHAIN.B3],
  // TC2
  [TC2.SPEND_BOTH_ID, TC2.SPEND_BOTH],
  // TC3 mempool
  [TC3_VALID_TX.TX_ID, TC3_VALID_TX.TX],
  [TC3_INVALID_TX.TX_ID, TC3_INVALID_TX.TX],
  [TC3_COINBASE_TX.TX_ID, TC3_COINBASE_TX.TX],
  // TC3 reorg
  [TC3_REORG.CB2_ALT_ID, TC3_REORG.CB2_ALT],
  [TC3_REORG.CB3_ALT_ID, TC3_REORG.CB3_ALT],
  [TC3_REORG.CB4_ALT_ID, TC3_REORG.CB4_ALT],
  [TC3_REORG.B2_ALT_ID, TC3_REORG.B2_ALT],
  [TC3_REORG.B3_ALT_ID, TC3_REORG.B3_ALT],
  [TC3_REORG.B4_ALT_ID, TC3_REORG.B4_ALT],
  // TC3 dead fork
  [TC3_DEAD_FORK.CB_DEAD_ID, TC3_DEAD_FORK.CB_DEAD],
  [TC3_DEAD_FORK.B3_DEAD_ID, TC3_DEAD_FORK.B3_DEAD],
  [TC3_DEAD_FORK.TX_FORK_A_ID, TC3_DEAD_FORK.TX_FORK_A],
  [TC3_DEAD_FORK.B4_DEAD_ID, TC3_DEAD_FORK.B4_DEAD],
  [TC3_DEAD_FORK.B5_DEAD_ID, TC3_DEAD_FORK.B5_DEAD],
  [TC3_DEAD_FORK.CB4_DEAD_ID, TC3_DEAD_FORK.CB4_DEAD],
  [TC3_DEAD_FORK.CB5_DEAD_ID, TC3_DEAD_FORK.CB5_DEAD],
]);
