import { beforeAll, describe, expect, test } from "bun:test";
import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import ProtocolError from "@/protocol/error";
import {
  ErrorCode,
  MessageType,
  ObjectType,
  type ObjectData,
} from "@/protocol/types";
import type {
  BlockMessage,
  Connection,
  ConnectedPeerContext,
  InputTransactionMessage,
  OutputTransactionMessage,
  TransactionMessage,
  UtxoSnapshot,
} from "./types";
import {
  getTxAmounts,
  validatePeers,
  resolveInputs,
  validateOutpoints,
  validateRegularTx,
  verifyLawOfConservationForRegularTx,
  verifySignatures,
  validateBlock,
} from "./validator";
import {
  createTestPrivateKey,
  getPublicKeyHex,
  signTransaction,
} from "@/test/transactionTestUtils";

const PREV_TX_ID = "11".repeat(32);
const RECIPIENT_PUBKEY = "22".repeat(32);

const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
};

function createContext(args: {
  objects?: Record<string, ObjectData>;
  blockTxs?: TransactionMessage[];
  parentUtxo?: UtxoSnapshot | null;
}): Connection {
  const ctx: ConnectedPeerContext = {
    id: "peer-1",
    peerManager: {
      broadcast: () => {},
    } as any,
    logger,
    objectManager: {
      put: async () => {},
      get: async (key: string) => args.objects?.[key] ?? null,
      id: (obj: unknown) => {
        const typed = obj as { type?: string };
        if (typed.type === ObjectType.BLOCK) {
          return hash(obj as BlockMessage);
        }
        return hash(obj as TransactionMessage);
      },
    } as any,
    blockManager: {
      async getUtxoSet(_blockId: string | null): Promise<any> {
        return args.parentUtxo ?? null;
      },
      async getBlock(_blockId: string): Promise<any> {
        return null;
      },
      async getBlockTransactions(_block: any, _ctx: any): Promise<any[]> {
        return args.blockTxs ?? [];
      },
      async storeAccepted(_result: any): Promise<void> {
        return;
      },
    } as any,
  };

  return {
    send: () => {},
    ctx,
    id: ctx.id,
    log: logger,
  };
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hash(obj: TransactionMessage | BlockMessage): string {
  const canonical = canonicalize(obj);
  if (!canonical) {
    throw new Error("Failed to canonicalize transaction in hash helper");
  }

  return bytesToHex(blake2s(Buffer.from(canonical, "utf-8")));
}

async function expectProtocolError(
  promise: Promise<unknown>,
  code: ErrorCode,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ProtocolError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).name).toBe(code);
  }
}

let senderPrivateKey: Uint8Array;
let senderPubkeyHex: string;
let previousTxObject: TransactionMessage;

const PSET2_COINBASE_ID =
  "b303d841891f91af118a319f99f5984def51091166ac73c062c98f86ea7371ee";
const PSET2_COINBASE: TransactionMessage = {
  type: ObjectType.TRANSACTION,
  height: 0,
  outputs: [
    {
      pubkey:
        "958f8add086cc348e229a3b6590c71b7d7754e42134a127a50648bf07969d9a0",
      value: 50000000000,
    },
  ],
};
const PSET2_VALID_SPEND: TransactionMessage = {
  type: ObjectType.TRANSACTION,
  inputs: [
    {
      outpoint: {
        index: 0,
        txid: PSET2_COINBASE_ID,
      },
      sig: "060bf7cbe141fecfebf6dafbd6ebbcff25f82e729a7770f4f3b1f81a7ec8a0ce4b287597e609b822111bbe1a83d682ef14f018f8a9143cef25ecc9a8b0c1c405",
    },
  ],
  outputs: [
    {
      pubkey:
        "958f8add086cc348e229a3b6590c71b7d7754e42134a127a50648bf07969d9a0",
      value: 10,
    },
  ],
};

const PSET3_BLOCK_TX_ID =
  "69de2ed6155a71bd28d78ef418b60b3b239014337b85bc996b4389ab8d017bcf";

const PSET3_BLOCK_TX: TransactionMessage = {
  type: ObjectType.TRANSACTION,
  height: 1,
  outputs: [
    {
      pubkey:
        "B6A95D7B410AE1EB924898AE584D21523B53AA5A78D1BC54ABE964FD8E63F487",
      value: 50000000000000,
    },
  ],
};
// Hardcode the production genesis ID so the block hash (and therefore PoW)
// stays correct regardless of NODE_ENV / isTest flag.
const PROD_GENESIS_BLOCK_ID =
  "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6";

const PSET3_VALID_BLOCK: BlockMessage = {
  T: "00000000abc00000000000000000000000000000000000000000000000000000",
  created: 1771488402,
  miner: "kalaburi",
  nonce: "32013974f028b6d2155088d5a2ec962130ea67d3f8f1d2cc6a55a02008c25b73",
  previd: PROD_GENESIS_BLOCK_ID,
  txids: [PSET3_BLOCK_TX_ID],
  type: ObjectType.BLOCK,
};

beforeAll(async () => {
  senderPrivateKey = createTestPrivateKey();
  senderPubkeyHex = await getPublicKeyHex(senderPrivateKey);

  previousTxObject = {
    type: ObjectType.TRANSACTION,
    height: 0,
    outputs: [{ pubkey: senderPubkeyHex, value: 50 }],
  };
});

describe("validatePeers", () => {
  const ctx = createContext({});

  test("accepts valid peer addresses", () => {
    expect(
      validatePeers(
        {
          type: MessageType.PEERS,
          peers: ["192.168.1.1:8080", "example.com:8080", "[::1]:8080"],
        },
        ctx,
      ),
    ).toBe(true);
  });

  test("accepts trimmed peer strings from the network", () => {
    expect(
      validatePeers(
        {
          type: MessageType.PEERS,
          peers: ["95.179.185.24:59362\r\n"],
        },
        ctx,
      ),
    ).toBe(true);
  });

  test("throws INVALID_FORMAT for malformed peer addresses", () => {
    expect(() =>
      validatePeers(
        {
          type: MessageType.PEERS,
          peers: ["bad-peer"],
        },
        ctx,
      ),
    ).toThrow(ProtocolError);

    expect(() =>
      validatePeers(
        {
          type: MessageType.PEERS,
          peers: ["bad-peer"],
        },
        ctx,
      ),
    ).toThrow("Received message with invalid format");
  });

  test("throws INVALID_FORMAT for invalid peer ports", () => {
    expect(() =>
      validatePeers(
        {
          type: MessageType.PEERS,
          peers: ["192.168.1.1:65536"],
        },
        ctx,
      ),
    ).toThrow(ProtocolError);

    expect(() =>
      validatePeers(
        {
          type: MessageType.PEERS,
          peers: ["192.168.1.1:65536"],
        },
        ctx,
      ),
    ).toThrow("Received message with invalid format");
  });
});

describe("validateOutpoints", () => {
  test("resolves known outpoints", async () => {
    const ctx = createContext({
      objects: { [PREV_TX_ID]: previousTxObject },
    });
    const inputs: InputTransactionMessage[] = [
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "aa".repeat(64),
      },
    ];

    const { resolvedInputs, txCache } = await resolveInputs(inputs, ctx);
    validateOutpoints(inputs, txCache);

    expect(resolvedInputs).toHaveLength(1);
    expect(resolvedInputs[0]?.resolvedOutput).toEqual(previousTxObject.outputs[0]);
  });

  test("throws UNKNOWN_OBJECT when outpoint tx is missing", async () => {
    const ctx = createContext({});
    const inputs: InputTransactionMessage[] = [
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "aa".repeat(64),
      },
    ];

    const { txCache } = await resolveInputs(inputs, ctx);
    try {
      validateOutpoints(inputs, txCache);
      throw new Error("Expected ProtocolError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).name).toBe(ErrorCode.UNKNOWN_OBJECT);
    }
  });

  test("throws INVALID_TX_OUTPOINT when index is too large", async () => {
    const ctx = createContext({ objects: { [PREV_TX_ID]: previousTxObject } });
    const inputs: InputTransactionMessage[] = [
      {
        outpoint: { txid: PREV_TX_ID, index: 1 },
        sig: "aa".repeat(64),
      },
    ];

    const { txCache } = await resolveInputs(inputs, ctx);
    try {
      validateOutpoints(inputs, txCache);
      throw new Error("Expected ProtocolError");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).name).toBe(ErrorCode.INVALID_TX_OUTPOINT);
    }
  });

  test("fetches each unique txid only once", async () => {
    let getObjectCalls = 0;
    const base = createContext({ objects: { [PREV_TX_ID]: previousTxObject } });
    const connection: Connection = {
      send: base.send,
      id: base.id,
      log: logger,
      ctx: {
        ...base.ctx,
        objectManager: {
          put: async () => {},
          get: async (key: string) => {
            getObjectCalls += 1;
            return key === PREV_TX_ID ? previousTxObject : null;
          },
        } as any,
        blockManager: {
          async getUtxoSet(_blockId: string): Promise<any> {
            return null;
          },
          async getBlock(_blockId: string): Promise<any> {
            return null;
          },
          async getBlockTransactions(_block: any, _ctx: any): Promise<any[]> {
            return [];
          },
          async storeAccepted(_result: any): Promise<void> {
            return;
          },
        } as any,
      },
    };

    const inputs: InputTransactionMessage[] = [
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "aa".repeat(64),
      },
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "bb".repeat(64),
      },
    ];

    await resolveInputs(inputs, connection);
    expect(getObjectCalls).toBe(1);
  });
});

describe("verifySignatures", () => {
  test("accepts a valid signature", async () => {
    const tx: TransactionMessage = {
      type: ObjectType.TRANSACTION,
      inputs: [
        {
          outpoint: { txid: PREV_TX_ID, index: 0 },
          sig: null,
        },
      ],
      outputs: [{ pubkey: RECIPIENT_PUBKEY, value: 10 }],
    };

    const sig = await signTransaction(tx, senderPrivateKey);
    tx.inputs![0]!.sig = sig;

    const resolvedInputs = [
      {
        ...tx.inputs![0]!,
        resolvedOutput: previousTxObject.outputs[0]!,
      },
    ];

    expect(verifySignatures(tx, resolvedInputs)).resolves.toBe(true);
  });

  test("throws INVALID_TX_SIGNATURE when signature is null", async () => {
    const tx: TransactionMessage = {
      type: ObjectType.TRANSACTION,
      inputs: [
        {
          outpoint: { txid: PREV_TX_ID, index: 0 },
          sig: null,
        },
      ],
      outputs: [{ pubkey: RECIPIENT_PUBKEY, value: 10 }],
    };

    const resolvedInputs = [
      {
        ...tx.inputs![0]!,
        resolvedOutput: previousTxObject.outputs[0]!,
      },
    ];

    await expectProtocolError(
      verifySignatures(tx, resolvedInputs),
      ErrorCode.INVALID_TX_SIGNATURE,
    );
  });

  test("throws INVALID_TX_SIGNATURE for invalid signatures", async () => {
    const tx: TransactionMessage = {
      type: ObjectType.TRANSACTION,
      inputs: [
        {
          outpoint: { txid: PREV_TX_ID, index: 0 },
          sig: "00".repeat(64),
        },
      ],
      outputs: [{ pubkey: RECIPIENT_PUBKEY, value: 10 }],
    };

    const resolvedInputs = [
      {
        ...tx.inputs![0]!,
        resolvedOutput: previousTxObject.outputs[0]!,
      },
    ];

    await expectProtocolError(
      verifySignatures(tx, resolvedInputs),
      ErrorCode.INVALID_TX_SIGNATURE,
    );
  });
});

describe("verifyLawOfConservation", () => {
  test("accepts transactions where total inputs >= total outputs", () => {
    const resolvedInputs = [
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "aa".repeat(64),
        resolvedOutput: { pubkey: senderPubkeyHex, value: 50 },
      },
    ];
    const newOutputs: OutputTransactionMessage[] = [
      { pubkey: RECIPIENT_PUBKEY, value: 10 },
      { pubkey: senderPubkeyHex, value: 40 },
    ];
    const txAmounts = getTxAmounts(resolvedInputs, newOutputs);

    expect(verifyLawOfConservationForRegularTx(txAmounts)).toBe(true);
  });

  test("throws INVALID_TX_CONSERVATION when outputs exceed inputs", () => {
    const resolvedInputs = [
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "aa".repeat(64),
        resolvedOutput: { pubkey: senderPubkeyHex, value: 5 },
      },
    ];
    const newOutputs: OutputTransactionMessage[] = [
      { pubkey: RECIPIENT_PUBKEY, value: 6 },
    ];
    const txAmounts = getTxAmounts(resolvedInputs, newOutputs);

    try {
      verifyLawOfConservationForRegularTx(txAmounts);
      throw new Error("Expected INVALID_TX_CONSERVATION");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).name).toBe(
        ErrorCode.INVALID_TX_CONSERVATION,
      );
    }
  });
});

describe("validateRegularTx", () => {
  test("throws INVALID_FORMAT for coinbase transactions", async () => {
    const ctx = createContext({});
    const coinbase: TransactionMessage = {
      type: ObjectType.TRANSACTION,
      height: 0,
      outputs: [{ pubkey: senderPubkeyHex, value: 50 }],
    };

    await expectProtocolError(
      validateRegularTx(coinbase, ctx),
      ErrorCode.INVALID_FORMAT,
    );
  });

  test("throws INVALID_FORMAT for non-coinbase transactions without inputs", async () => {
    const ctx = createContext({});
    const malformedTx = {
      type: ObjectType.TRANSACTION,
      outputs: [{ pubkey: senderPubkeyHex, value: 50 }],
    } as TransactionMessage;

    await expectProtocolError(
      validateRegularTx(malformedTx, ctx),
      ErrorCode.INVALID_FORMAT,
    );
  });

  test("accepts a valid signed non-coinbase transaction", async () => {
    const ctx = createContext({ objects: { [PREV_TX_ID]: previousTxObject } });
    const tx: TransactionMessage = {
      type: ObjectType.TRANSACTION,
      inputs: [
        {
          outpoint: { txid: PREV_TX_ID, index: 0 },
          sig: null,
        },
      ],
      outputs: [{ pubkey: RECIPIENT_PUBKEY, value: 10 }],
    };

    tx.inputs![0]!.sig = await signTransaction(tx, senderPrivateKey);

    expect(!!(await validateRegularTx(tx, ctx))).toBe(true);
  });

  test("accepts PSET2 transaction example", async () => {
    const ctx = createContext({
      objects: {
        [PSET2_COINBASE_ID]: PSET2_COINBASE,
      },
    });

    expect(!!(await validateRegularTx(PSET2_VALID_SPEND, ctx))).toBe(true);
  });

  test("rejects a tampered PSET2 signature", async () => {
    const ctx = createContext({
      objects: {
        [PSET2_COINBASE_ID]: PSET2_COINBASE,
      },
    });
    const tamperedTx: TransactionMessage = {
      ...PSET2_VALID_SPEND,
      inputs: PSET2_VALID_SPEND.inputs!.map((input, index) => ({
        ...input,
        sig: index === 0 ? `1${input.sig!.slice(1)}` : input.sig,
      })),
    };

    await expectProtocolError(
      validateRegularTx(tamperedTx, ctx),
      ErrorCode.INVALID_TX_SIGNATURE,
    );
  });
});

describe("PSET2 transaction vector", () => {
  test("matches the documented PSET2 coinbase txid", () => {
    expect(hash(PSET2_COINBASE)).toBe(PSET2_COINBASE_ID);
  });
});

describe("validateBlock", () => {
  test("returns null when parent UTXO is missing", async () => {
    const ctx = createContext({
      parentUtxo: null,
      blockTxs: [PSET3_BLOCK_TX],
    });
    expect(validateBlock(PSET3_VALID_BLOCK, ctx)).resolves.toBeNull();
  });
  test("matches the documented PSET3 coinbase txid", () => {
    expect(hash(PSET3_BLOCK_TX)).toBe(PSET3_BLOCK_TX_ID);
  });
  test("accepts the documented block mined on genesis", async () => {
    const ctx = createContext({
      parentUtxo: new Map(),
      blockTxs: [PSET3_BLOCK_TX],
    });
    const result = await validateBlock(PSET3_VALID_BLOCK, ctx);
    expect(result).not.toBeNull();
    expect(result?.blockId).toBe(hash(PSET3_VALID_BLOCK));
    expect(result?.utxoSetAfterTxApply.get(`${PSET3_BLOCK_TX_ID}:0`)).toEqual({
      txid: PSET3_BLOCK_TX_ID,
      index: 0,
      output: PSET3_BLOCK_TX.outputs[0]!,
    });
  });
});
