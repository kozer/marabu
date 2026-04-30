import * as ed from "@noble/ed25519";
import { bytesToHex } from "@noble/hashes/utils.js";
import { GENESIS_BLOCK_ID, BLOCK_REWARD, ObjectType } from "@/protocol/types";
import { buildBlock, buildSpend, coinbase, nonce, oid } from "../test_helpers";

// ── Key pairs ───────────────────────────────────────────

const SK = new Uint8Array(Buffer.from("01".repeat(32), "hex"));
export const PK = bytesToHex(await ed.getPublicKeyAsync(SK));

const SK2 = new Uint8Array(Buffer.from("02".repeat(32), "hex"));
export const PK2 = bytesToHex(await ed.getPublicKeyAsync(SK2));

const SK3 = new Uint8Array(Buffer.from("03".repeat(32), "hex"));
export const PK3 = bytesToHex(await ed.getPublicKeyAsync(SK3));

//  Testcase 2 – Block with coinbase
export const TC2 = (() => {
  const cb = coinbase(1, PK, BLOCK_REWARD);
  const cbId = oid(cb);

  const block = buildBlock({
    created: 1771162955,
    miner: "grader",
    nonce: nonce(1),
    note: "This block has a coinbase transaction",
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

//  Testcase 3 – Spend earlier coinbase
export const TC3 = await (async () => {
  const cb1 = TC2.CB;
  const cb1Id = TC2.CB_ID;

  const cb2 = coinbase(2, PK, BLOCK_REWARD);
  const cb2Id = oid(cb2);

  const spend = await buildSpend(cb1Id, PK, BLOCK_REWARD, SK);
  const spendId = oid(spend);

  const block2 = buildBlock({
    created: 1771162955,
    miner: "grader",
    nonce: nonce(1),
    note: "This block has a coinbase transaction",
    previd: GENESIS_BLOCK_ID,
    txids: [cb1Id],
  });

  const block3 = buildBlock({
    created: 1771166555,
    miner: "grader",
    nonce: nonce(2),
    note: "This block has another coinbase and spends earlier coinbase",
    previd: oid(block2),
    txids: [oid(cb2), spendId],
  });

  return {
    CB1: cb1,
    CB1_ID: cb1Id,
    CB2: cb2,
    CB2_ID: cb2Id,
    SPEND: spend,
    SPEND_ID: spendId,
    BLOCK2: block2,
    BLOCK2_ID: oid(block2),
    BLOCK3: block3,
    BLOCK3_ID: oid(block3),
  };
})();

//  Testcase 5 – Coinbase conservation violation
export const TC5 = await (async () => {
  const cb = coinbase(1, PK, BLOCK_REWARD);
  const cbId = oid(cb);

  const overpaidCb = coinbase(1, PK, BLOCK_REWARD * 2);
  const overpaidId = oid(overpaidCb);

  const blockA = buildBlock({
    created: 1771170155,
    miner: "grader",
    nonce: nonce(3),
    note: "This block has a coinbase transaction",
    previd: GENESIS_BLOCK_ID,
    txids: [cbId],
  });

  const blockB = buildBlock({
    created: 1771173755,
    miner: "grader",
    nonce: nonce(4),
    note: "This block violates the law of conservation",
    previd: oid(blockA),
    txids: [overpaidId],
  });

  return {
    CB: cb,
    CB_ID: cbId,
    OVERPAID_CB: overpaidCb,
    OVERPAID_CB_ID: overpaidId,
    BLOCK_A: blockA,
    BLOCK_A_ID: oid(blockA),
    BLOCK_B: blockB,
  };
})();

//  Testcase 6 – Coinbase spent in same block
export const TC6 = await (async () => {
  const cb = coinbase(1, PK, BLOCK_REWARD);
  const cbId = oid(cb);

  const spend = await buildSpend(cbId, PK, BLOCK_REWARD, SK);
  const spendId = oid(spend);

  const block = buildBlock({
    created: 1771173755,
    miner: "grader",
    nonce: nonce(5),
    note: "This block has a transaction spending the coinbase",
    previd: GENESIS_BLOCK_ID,
    txids: [cbId, spendId],
  });

  return {
    CB: cb,
    CB_ID: cbId,
    SPEND: spend,
    SPEND_ID: spendId,
    BLOCK: block,
  };
})();

//  Testcase 7 – Invalid tx (null signature) in block
export const TC7 = (() => {
  const cb = coinbase(1, PK, BLOCK_REWARD);
  const cbId = oid(cb);

  const invalidTx = {
    type: ObjectType.TRANSACTION,
    inputs: [{ outpoint: { txid: "f".repeat(64), index: 0 }, sig: null }],
    outputs: [{ pubkey: PK, value: BLOCK_REWARD }],
  };
  const invalidId = oid(invalidTx);

  const block = buildBlock({
    created: 1771177355,
    miner: "grader",
    nonce: nonce(6),
    note: "This block contains an invalid transaction",
    previd: GENESIS_BLOCK_ID,
    txids: [cbId, invalidId],
  });

  return {
    CB: cb,
    CB_ID: cbId,
    INVALID_TX: invalidTx,
    INVALID_TX_ID: invalidId,
    BLOCK: block,
  };
})();

//  Testcase 8 – Two coinbase transactions in block
export const TC8 = (() => {
  const cb = coinbase(1, PK, BLOCK_REWARD);
  const cbId = oid(cb);

  const block = buildBlock({
    created: 1771180955,
    miner: "grader",
    nonce: nonce(7),
    note: "This block has 2 coinbase transactions",
    previd: GENESIS_BLOCK_ID,
    txids: [cbId, cbId],
  });

  return {
    CB: cb,
    CB_ID: cbId,
    BLOCK: block,
  };
})();

//  Testcase 9 – Double spend within a block
export const TC9 = await (async () => {
  const cb = coinbase(1, PK2, BLOCK_REWARD);
  const cbId = oid(cb);

  const ds1 = await buildSpend(cbId, PK2, BLOCK_REWARD - 1, SK2);
  const ds2 = await buildSpend(cbId, PK2, 1, SK2);

  const blockA = buildBlock({
    created: 1771184555,
    miner: "grader",
    nonce: nonce(8),
    note: "This block has a coinbase transaction",
    previd: GENESIS_BLOCK_ID,
    txids: [cbId],
  });

  const blockB = buildBlock({
    created: 1771188155,
    miner: "grader",
    nonce: nonce(9),
    note: "This block spends coinbase transaction twice",
    previd: oid(blockA),
    txids: [oid(ds1), oid(ds2)],
  });

  return {
    CB: cb,
    CB_ID: cbId,
    DS1: ds1,
    DS1_ID: oid(ds1),
    DS2: ds2,
    DS2_ID: oid(ds2),
    BLOCK_A: blockA,
    BLOCK_A_ID: oid(blockA),
    BLOCK_B: blockB,
  };
})();

//  Testcase 10 – Double spend in successive blocks
export const TC10 = await (async () => {
  const cb = coinbase(1, PK3, BLOCK_REWARD);
  const cbId = oid(cb);

  const spend = await buildSpend(cbId, PK3, BLOCK_REWARD - 1, SK3);
  const ds = await buildSpend(cbId, PK3, BLOCK_REWARD - 1, SK3);

  const blockA = buildBlock({
    created: 1771191755,
    miner: "grader",
    nonce: nonce(10),
    note: "This block has a coinbase transaction",
    previd: GENESIS_BLOCK_ID,
    txids: [cbId],
  });

  const blockB = buildBlock({
    created: 1771195355,
    miner: "grader",
    nonce: nonce(11),
    note: "This block spends coinbase transaction once (it is valid)",
    previd: oid(blockA),
    txids: [oid(spend)],
  });

  const blockC = buildBlock({
    created: 1771198955,
    miner: "grader",
    nonce: nonce(12),
    note: "This block spends coinbase transaction again (it is invalid)",
    previd: oid(blockB),
    txids: [oid(ds)],
  });

  return {
    CB: cb,
    CB_ID: cbId,
    SPEND: spend,
    SPEND_ID: oid(spend),
    DOUBLE_SPEND: ds,
    DOUBLE_SPEND_ID: oid(ds),
    BLOCK_A: blockA,
    BLOCK_A_ID: oid(blockA),
    BLOCK_B: blockB,
    BLOCK_B_ID: oid(blockB),
    BLOCK_C: blockC,
  };
})();

//  Testcase 11 – Spend UTXO not in any chain block
export const TC11 = await (async () => {
  const cb = coinbase(1, PK2, BLOCK_REWARD - 1);
  const cbId = oid(cb);

  const spend = await buildSpend(cbId, PK2, BLOCK_REWARD - 2, SK2);

  const block = buildBlock({
    created: 1771198955,
    miner: "grader",
    nonce: nonce(13),
    note: "This block spends a coinbase transaction not in its prev blocks",
    previd: GENESIS_BLOCK_ID,
    txids: [oid(spend)],
  });

  return {
    CB: cb,
    CB_ID: cbId,
    SPEND: spend,
    SPEND_ID: oid(spend),
    BLOCK: block,
  };
})();

export const P3_GLOBAL_STORE = new Map<string, unknown>([
  // tc2
  [TC2.CB_ID, TC2.CB],
  // tc3
  [TC3.CB1_ID, TC3.CB1],
  [TC3.CB2_ID, TC3.CB2],
  [TC3.SPEND_ID, TC3.SPEND],
  // tc5
  [TC5.CB_ID, TC5.CB],
  [TC5.OVERPAID_CB_ID, TC5.OVERPAID_CB],
  // tc6
  [TC6.CB_ID, TC6.CB],
  [TC6.SPEND_ID, TC6.SPEND],
  // tc7
  [TC7.CB_ID, TC7.CB],
  [TC7.INVALID_TX_ID, TC7.INVALID_TX],
  // tc8
  [TC8.CB_ID, TC8.CB],
  // tc9
  [TC9.CB_ID, TC9.CB],
  [TC9.DS1_ID, TC9.DS1],
  [TC9.DS2_ID, TC9.DS2],
  // tc10
  [TC10.CB_ID, TC10.CB],
  [TC10.SPEND_ID, TC10.SPEND],
  [TC10.DOUBLE_SPEND_ID, TC10.DOUBLE_SPEND],
  // tc11
  [TC11.CB_ID, TC11.CB],
  [TC11.SPEND_ID, TC11.SPEND],
]);
