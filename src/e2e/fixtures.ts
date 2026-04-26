import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as ed from "@noble/ed25519";

function oid(obj: any): string {
  return bytesToHex(blake2s(Buffer.from(canonicalize(obj)!, "utf8")));
}

const TARGET = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function nonce(n: number): string {
  return "0".repeat(63) + n.toString(16);
}

type BlockDef = {
  created: number;
  miner: string;
  nonce: string;
  note: string;
  previd: string | null;
  txids: string[];
};

function buildBlock(n: BlockDef): any {
  return { T: TARGET, ...n, type: "block" };
}

// ── Key pairs ──
const SK = new Uint8Array(Buffer.from("01".repeat(32), "hex"));
const PK = bytesToHex(await ed.getPublicKeyAsync(SK));
const SK2 = new Uint8Array(Buffer.from("02".repeat(32), "hex"));
const PK2 = bytesToHex(await ed.getPublicKeyAsync(SK2));
const SK3 = new Uint8Array(Buffer.from("03".repeat(32), "hex"));
const PK3 = bytesToHex(await ed.getPublicKeyAsync(SK3));

async function signTx(tx: any, key: Uint8Array = SK): Promise<string> {
  const txCopy = { ...tx, inputs: tx.inputs?.map((i: any) => ({ ...i, sig: null })) };
  const msg = new Uint8Array(Buffer.from(canonicalize(txCopy)!, "utf-8"));
  const sig = await ed.signAsync(msg, key);
  return bytesToHex(sig);
}

// ── Genesis ──
const GENESIS = buildBlock({
  created: 1771159355,
  miner: "Marabu",
  nonce: "0".repeat(64),
  note: "Financial Times 2026-02-13: Crypto battle",
  previd: null,
  txids: [],
});

export const GENESIS_BLOCK = GENESIS;
export const GENESIS_BLOCK_ID = oid(GENESIS);

// ── Builders ──
const R = 50000000000000;

function coinbase(height: number, pk: string, val: number): any {
  return { type: "transaction", height, outputs: [{ pubkey: pk, value: val }] };
}

async function buildSpend(
  txid: string,
  pk: string,
  val: number,
  key: Uint8Array = SK,
): Promise<any> {
  const tx: any = {
    type: "transaction",
    inputs: [{ outpoint: { txid, index: 0 }, sig: null }],
    outputs: [{ pubkey: pk, value: val }],
  };
  tx.inputs[0].sig = await signTx(tx, key);
  return tx;
}

// ── Coinbase objects ──
export const TX_OBJ_CB1 = coinbase(1, PK, R); // tc2, tc5-A, tc6, tc7, tc8
export const TX_OBJ_CB2 = coinbase(2, PK, R); // tc3 (height 2)
const TX_OBJ_CB9 = coinbase(1, PK2, R); // tc9-A (diff ID via PK2)
const TX_OBJ_CB10 = coinbase(1, PK3, R); // tc10-A (diff ID via PK3)
export const TX_OBJ_CB_S = coinbase(1, PK2, R - 1); // tc11 standalone (diff from CB9 via value)

const _cb1 = oid(TX_OBJ_CB1);
const _cb9 = oid(TX_OBJ_CB9);
const _cb10 = oid(TX_OBJ_CB10);

// ── Spending objects ──
export const TX_OBJ_SPEND_CB1 = await buildSpend(_cb1, PK, R, SK);
export const TX_OBJ_CONSERVATION = coinbase(1, PK, R * 2); // output > reward
export const TX_OBJ_INVALID_SIG = {
  type: "transaction",
  inputs: [{ outpoint: { txid: "f".repeat(64), index: 0 }, sig: null }],
  outputs: [{ pubkey: PK, value: R }],
};
// tc9: DS1+DS2 both spend CB9 (PK2, value R). Sign with SK2.
export const TX_OBJ_DS1 = await buildSpend(_cb9, PK2, R - 1, SK2);
export const TX_OBJ_DS2 = await buildSpend(_cb9, PK2, 1, SK2);
// tc10: SPEND+DS spend CB10 (PK3, value R). Sign with SK3.
export const TX_OBJ_SPEND_CB10 = await buildSpend(_cb10, PK3, R - 1, SK3);
export const TX_OBJ_DS_CB10 = await buildSpend(_cb10, PK3, R - 1, SK3);
// tc11: spends standalone coinbase (in DB but not in chain UTXO set)
const _cb_s = oid(TX_OBJ_CB_S);
export const TX_OBJ_UTXO_GONE = await buildSpend(_cb_s, PK2, R - 2, SK2);

// ── Transaction IDs ──
export const TX = {
  CB_BLOCK2: oid(TX_OBJ_CB1),
  CB_BLOCK3_1: oid(TX_OBJ_CB2),
  CB_BLOCK3_2: oid(TX_OBJ_SPEND_CB1),
  CB_TC5: oid(TX_OBJ_CB1),
  CONSERVATION: oid(TX_OBJ_CONSERVATION),
  CB_TC6: oid(TX_OBJ_CB1),
  SPEND_TC6: oid(TX_OBJ_SPEND_CB1),
  CB_TC7: oid(TX_OBJ_CB1),
  INVALID_SIG: oid(TX_OBJ_INVALID_SIG),
  CB_TC8: oid(TX_OBJ_CB1),
  CB_TC9: oid(TX_OBJ_CB9),
  DS1: oid(TX_OBJ_DS1),
  DS2: oid(TX_OBJ_DS2),
  CB_TC10: oid(TX_OBJ_CB10),
  SPEND_TC10B: oid(TX_OBJ_SPEND_CB10),
  SPEND_TC10C: oid(TX_OBJ_DS_CB10),
  UTXO_GONE: oid(TX_OBJ_UTXO_GONE),
  STANDALONE: oid(TX_OBJ_CB_S),
} as const;

// ── GLOBAL_STORE map ──
export const TX_OBJECTS: Record<string, any> = {
  [TX.CB_BLOCK2]: TX_OBJ_CB1,
  [TX.CB_BLOCK3_1]: TX_OBJ_CB2,
  [TX.CB_BLOCK3_2]: TX_OBJ_SPEND_CB1,
  [TX.CONSERVATION]: TX_OBJ_CONSERVATION,
  [TX.SPEND_TC6]: TX_OBJ_SPEND_CB1,
  [TX.INVALID_SIG]: TX_OBJ_INVALID_SIG,
  [TX.CB_TC9]: TX_OBJ_CB9,
  [TX.DS1]: TX_OBJ_DS1,
  [TX.DS2]: TX_OBJ_DS2,
  [TX.CB_TC10]: TX_OBJ_CB10,
  [TX.SPEND_TC10B]: TX_OBJ_SPEND_CB10,
  [TX.SPEND_TC10C]: TX_OBJ_DS_CB10,
  [TX.UTXO_GONE]: TX_OBJ_UTXO_GONE,
  [TX.STANDALONE]: TX_OBJ_CB_S,
};

// ── PSET 3 blocks ──
const B2 = buildBlock({
  created: 1771162955,
  miner: "grader",
  nonce: nonce(1),
  note: "This block has a coinbase transaction",
  previd: GENESIS_BLOCK_ID,
  txids: [TX.CB_BLOCK2],
});
export const BLOCK2 = B2;
export const BLOCK2_ID = oid(B2);

const B3 = buildBlock({
  created: 1771166555,
  miner: "grader",
  nonce: nonce(2),
  note: "This block has another coinbase and spends earlier coinbase",
  previd: BLOCK2_ID,
  txids: [TX.CB_BLOCK3_1, TX.CB_BLOCK3_2],
});
export const BLOCK3 = B3;
export const BLOCK3_ID = oid(B3);

// tc5: conservation
const BA5 = buildBlock({
  created: 1771170155,
  miner: "grader",
  nonce: nonce(3),
  note: "This block has a coinbase transaction",
  previd: GENESIS_BLOCK_ID,
  txids: [TX.CB_TC5],
});
export const BLOCK_A_5 = BA5;
export const BLOCK_A_5_ID = oid(BA5);

const BB5 = buildBlock({
  created: 1771173755,
  miner: "grader",
  nonce: nonce(4),
  note: "This block violates the law of conservation",
  previd: BLOCK_A_5_ID,
  txids: [TX.CONSERVATION],
});
export const BLOCK_B_5 = BB5;

// tc6: coinbase spent same block
const B6 = buildBlock({
  created: 1771173755,
  miner: "grader",
  nonce: nonce(5),
  note: "This block has a transaction spending the coinbase",
  previd: GENESIS_BLOCK_ID,
  txids: [TX.CB_TC6, TX.SPEND_TC6],
});
export const BLOCK6 = B6;

// tc7: invalid/unfindable tx
const B7 = buildBlock({
  created: 1771177355,
  miner: "grader",
  nonce: nonce(6),
  note: "This block contains an invalid transaction",
  previd: GENESIS_BLOCK_ID,
  txids: [TX.CB_TC7, TX.INVALID_SIG],
});
export const BLOCK7 = B7;

// tc8: two coinbases
const B8 = buildBlock({
  created: 1771180955,
  miner: "grader",
  nonce: nonce(7),
  note: "This block has 2 coinbase transactions",
  previd: GENESIS_BLOCK_ID,
  txids: [TX.CB_TC8, TX.CB_TC8],
});
export const BLOCK8 = B8;

// tc9: double spend within block
const BA9 = buildBlock({
  created: 1771184555,
  miner: "grader",
  nonce: nonce(8),
  note: "This block has a coinbase transaction",
  previd: GENESIS_BLOCK_ID,
  txids: [TX.CB_TC9],
});
export const BLOCK_A_9 = BA9;
export const BLOCK_A_9_ID = oid(BA9);

const BB9 = buildBlock({
  created: 1771188155,
  miner: "grader",
  nonce: nonce(9),
  note: "This block spends coinbase transaction twice",
  previd: BLOCK_A_9_ID,
  txids: [TX.DS1, TX.DS2],
});
export const BLOCK_B_9 = BB9;

// tc10: double spend successive
const BA10 = buildBlock({
  created: 1771191755,
  miner: "grader",
  nonce: nonce(10),
  note: "This block has a coinbase transaction",
  previd: GENESIS_BLOCK_ID,
  txids: [TX.CB_TC10],
});
export const BLOCK_A_10 = BA10;
export const BLOCK_A_10_ID = oid(BA10);

const BB10 = buildBlock({
  created: 1771195355,
  miner: "grader",
  nonce: nonce(11),
  note: "This block spends coinbase transaction once (it is valid)",
  previd: BLOCK_A_10_ID,
  txids: [TX.SPEND_TC10B],
});
export const BLOCK_B_10 = BB10;
export const BLOCK_B_10_ID = oid(BB10);

const BC10 = buildBlock({
  created: 1771198955,
  miner: "grader",
  nonce: nonce(12),
  note: "This block spends coinbase transaction again (it is invalid)",
  previd: BLOCK_B_10_ID,
  txids: [TX.SPEND_TC10C],
});
export const BLOCK_C_10 = BC10;

// tc11: UTXO not in chain
const B11 = buildBlock({
  created: 1771198955,
  miner: "grader",
  nonce: nonce(13),
  note: "This block spends a coinbase transaction not in its prev blocks",
  previd: GENESIS_BLOCK_ID,
  txids: [TX.UTXO_GONE],
});
export const BLOCK11 = B11;

// ── PSET 4 coinbases ──
const P4_CB1 = { type: "transaction", height: 1, outputs: [{ pubkey: PK, value: R }] };
const P4_CB2 = { type: "transaction", height: 2, outputs: [{ pubkey: PK, value: R }] };
const P4_CB3 = { type: "transaction", height: 3, outputs: [{ pubkey: PK, value: R }] };
const P4_CB3_ID = oid(P4_CB3);
const P4_CB99 = { type: "transaction", height: 99, outputs: [{ pubkey: PK, value: R }] };
const P4_CB1_ID = oid(P4_CB1);
const P4_CB2_ID = oid(P4_CB2);
const P4_CB99_ID = oid(P4_CB99);

const P4_WRONG_CB = buildBlock({
  created: 1771162955,
  miner: "grader",
  nonce: nonce(6),
  note: "Coinbase has wrong height",
  previd: GENESIS_BLOCK_ID,
  txids: [P4_CB99_ID],
});
export const P4_BLOCK_WRONG_CB = P4_WRONG_CB;
export const P4_BLOCK_WRONG_CB_ID = oid(P4_WRONG_CB);

const P4_A1 = buildBlock({
  created: 1771162955,
  miner: "grader",
  nonce: "0".repeat(62) + "a1",
  note: "Chain A block 1",
  previd: GENESIS_BLOCK_ID,
  txids: [P4_CB1_ID],
});
export const P4_BLOCK_A1 = P4_A1;
export const P4_BLOCK_A1_ID = oid(P4_A1);

const P4_B1 = buildBlock({
  created: 1771162956,
  miner: "grader",
  nonce: "0".repeat(62) + "b1",
  note: "Chain B block 1",
  previd: GENESIS_BLOCK_ID,
  txids: [P4_CB1_ID],
});
const P4_B1_ID = oid(P4_B1);
export const P4_BLOCK_B1 = P4_B1;

const P4_B2 = buildBlock({
  created: 1771162957,
  miner: "grader",
  nonce: "0".repeat(62) + "b2",
  note: "Chain B block 2",
  previd: P4_B1_ID,
  txids: [P4_CB2_ID],
});
const P4_B2_ID = oid(P4_B2);
export const P4_BLOCK_B2 = P4_B2;

const P4_B3 = buildBlock({
  created: 1771162958,
  miner: "grader",
  nonce: "0".repeat(62) + "b3",
  note: "Chain B block 3",
  previd: P4_B2_ID,
  txids: [P4_CB3_ID],
});
export const P4_BLOCK_B3 = P4_B3;
export const P4_BLOCK_B3_ID = oid(P4_B3);

// ── PSET 4 invalid test blocks ──
const P4_FAKE_PARENT = "000000000000000000000000000000000000000000000000000000000000dead";
const P4_MISSING_PARENT = buildBlock({
  created: 1771162955,
  miner: "grader",
  nonce: "0".repeat(64).slice(0, 63) + "1",
  note: "Points to unavailable block",
  previd: P4_FAKE_PARENT,
  txids: [],
});
export const P4_BLOCK_MISSING_PARENT = P4_MISSING_PARENT;
export const P4_BLOCK_MISSING_PARENT_ID = oid(P4_MISSING_PARENT);

const P4_BAD_TIMESTAMP = buildBlock({
  created: 1771159355,
  miner: "grader",
  nonce: "0".repeat(64).slice(0, 63) + "2",
  note: "Non-increasing timestamp",
  previd: GENESIS_BLOCK_ID,
  txids: [],
});
export const P4_BLOCK_BAD_TIMESTAMP = P4_BAD_TIMESTAMP;
export const P4_BLOCK_BAD_TIMESTAMP_ID = oid(P4_BAD_TIMESTAMP);

const P4_FUTURE_TIMESTAMP = buildBlock({
  created: 2281468800,
  miner: "grader",
  nonce: "0".repeat(64).slice(0, 63) + "3",
  note: "Block from the future",
  previd: GENESIS_BLOCK_ID,
  txids: [],
});
export const P4_BLOCK_FUTURE = P4_FUTURE_TIMESTAMP;
export const P4_BLOCK_FUTURE_ID = oid(P4_FUTURE_TIMESTAMP);

const P4_BAD_POW = {
  T: "0".repeat(64),
  created: 1771162955,
  miner: "grader",
  nonce: "0".repeat(64).slice(0, 63) + "4",
  note: "Invalid PoW",
  previd: GENESIS_BLOCK_ID,
  txids: [],
  type: "block",
};
export const P4_BLOCK_BAD_POW = P4_BAD_POW;
export const P4_BLOCK_BAD_POW_ID = oid(P4_BAD_POW);

// ── P4 GLOBAL_STORE ──
export const P4_GLOBAL_STORE: Record<string, any> = {
  [P4_CB1_ID]: P4_CB1,
  [P4_CB2_ID]: P4_CB2,
  [P4_CB3_ID]: P4_CB3,
  [P4_CB99_ID]: P4_CB99,
};
