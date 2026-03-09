import { beforeAll, describe, expect, test } from "bun:test";
import canonicalize from "canonicalize";
import * as ed from "@noble/ed25519";
import { MessageType } from "./constants";
import ProtocolError, { ErrorCode } from "./error";
import type {
  ConnectedPeerContext,
  InputTransactionMessage,
  OutputTransactionMessage,
  TransactionMessage,
} from "./types";
import {
  validateHost,
  validateOutpoints,
  validateTransaction,
  verifyLawOfConservation,
  verifySignatures,
} from "./validator";

const PREV_TX_ID = "11".repeat(32);
const RECIPIENT_PUBKEY = "22".repeat(32);

const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
};

function createContext(objects: Record<string, unknown>): ConnectedPeerContext {
  return {
    id: "peer-1",
    socket: {} as any,
    peerManager: {} as any,
    logger,
    db: {
      addObject: async () => {},
      validateObject: async () => true,
      getObject: async (key: string) => objects[key] ?? null,
    },
  };
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function signTransaction(
  tx: TransactionMessage,
  privateKey: Uint8Array,
): Promise<string> {
  const txForSigning: TransactionMessage = {
    ...tx,
    inputs: tx.inputs?.map((input) => ({
      ...input,
      sig: null,
    })),
  };
  const canonical = canonicalize(txForSigning);
  if (!canonical) {
    throw new Error("Failed to canonicalize transaction in test helper");
  }
  const msgBytes = new Uint8Array(Buffer.from(canonical, "utf-8"));
  const sig = await ed.signAsync(msgBytes, privateKey);
  return toHex(sig);
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
    expect((error as ProtocolError).code).toBe(code);
  }
}

let senderPrivateKey: Uint8Array;
let senderPubkeyHex: string;
let previousTx: TransactionMessage;

beforeAll(async () => {
  senderPrivateKey = new Uint8Array(Buffer.from("01".repeat(32), "hex"));
  const senderPubkey = await ed.getPublicKeyAsync(senderPrivateKey);
  senderPubkeyHex = toHex(senderPubkey);

  previousTx = {
    type: MessageType.TRANSACTION,
    height: 0,
    outputs: [{ pubkey: senderPubkeyHex, value: 50 }],
  };
});

describe("validateHost", () => {
  test("should validate valid host:port", () => {
    expect(validateHost("192.168.1.1:8080")).toBe(true);
  });

  test("should validate hostname:port", () => {
    expect(validateHost("example.com:8080")).toBe(true);
  });

  test("should reject port 0", () => {
    expect(validateHost("192.168.1.1:0")).toBe(false);
  });

  test("should reject negative port", () => {
    expect(validateHost("192.168.1.1:-1")).toBe(false);
  });

  test("should reject port > 65535", () => {
    expect(validateHost("192.168.1.1:65536")).toBe(false);
  });

  test("should reject non-numeric port", () => {
    expect(validateHost("192.168.1.1:abc")).toBe(false);
  });

  test("should reject no colon", () => {
    expect(validateHost("192.168.1.1")).toBe(false);
  });

  test("should reject empty string", () => {
    expect(validateHost("")).toBe(false);
  });

  test("should handle newline in input (after trimming)", () => {
    expect(validateHost("192.168.1.1:8080\n")).toBe(true);
  });

  test("should handle carriage return in input", () => {
    expect(validateHost("192.168.1.1:8080\r")).toBe(true);
  });

  test("should handle Windows \r\n ending in input", () => {
    expect(validateHost("192.168.1.1:8080\r\n")).toBe(true);
  });

  test("should validate trimmed peer from network", () => {
    expect(validateHost("95.179.185.24:59362")).toBe(true);
  });
});

describe("validateOutpoints", () => {
  test("resolves known outpoints", async () => {
    const ctx = createContext({ [PREV_TX_ID]: previousTx });
    const inputs: InputTransactionMessage[] = [
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "aa".repeat(64),
      },
    ];

    const resolved = await validateOutpoints(inputs, ctx);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.resolvedOutput).toEqual(previousTx.outputs[0]);
  });

  test("throws UNKNOWN_OBJECT when outpoint tx is missing", async () => {
    const ctx = createContext({});
    const inputs: InputTransactionMessage[] = [
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "aa".repeat(64),
      },
    ];

    await expectProtocolError(
      validateOutpoints(inputs, ctx),
      ErrorCode.UNKNOWN_OBJECT,
    );
  });

  test("throws INVALID_TX_OUTPOINT when index is too large", async () => {
    const ctx = createContext({ [PREV_TX_ID]: previousTx });
    const inputs: InputTransactionMessage[] = [
      {
        outpoint: { txid: PREV_TX_ID, index: 1 },
        sig: "aa".repeat(64),
      },
    ];

    await expectProtocolError(
      validateOutpoints(inputs, ctx),
      ErrorCode.INVALID_TX_OUTPOINT,
    );
  });

  test("fetches each unique txid only once", async () => {
    let getObjectCalls = 0;
    const ctx = {
      ...createContext({ [PREV_TX_ID]: previousTx }),
      db: {
        addObject: async () => {},
        validateObject: async () => true,
        getObject: async (key: string) => {
          getObjectCalls += 1;
          return key === PREV_TX_ID ? previousTx : null;
        },
      },
    } as ConnectedPeerContext;

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

    await validateOutpoints(inputs, ctx);
    expect(getObjectCalls).toBe(1);
  });
});

describe("verifySignatures", () => {
  test("accepts a valid signature", async () => {
    const tx: TransactionMessage = {
      type: MessageType.TRANSACTION,
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
        resolvedOutput: previousTx.outputs[0]!,
      },
    ];

    expect(verifySignatures(tx, resolvedInputs)).resolves.toBe(true);
  });

  test("throws INVALID_TX_SIGNATURE when signature is null", async () => {
    const tx: TransactionMessage = {
      type: MessageType.TRANSACTION,
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
        resolvedOutput: previousTx.outputs[0]!,
      },
    ];

    await expectProtocolError(
      verifySignatures(tx, resolvedInputs),
      ErrorCode.INVALID_TX_SIGNATURE,
    );
  });

  test("throws INVALID_TX_SIGNATURE for invalid signatures", async () => {
    const tx: TransactionMessage = {
      type: MessageType.TRANSACTION,
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
        resolvedOutput: previousTx.outputs[0]!,
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

    expect(verifyLawOfConservation(resolvedInputs, newOutputs)).toBe(true);
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

    try {
      verifyLawOfConservation(resolvedInputs, newOutputs);
      throw new Error("Expected INVALID_TX_CONSERVATION");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(
        ErrorCode.INVALID_TX_CONSERVATION,
      );
    }
  });
});

describe("validateTransaction", () => {
  test("accepts coinbase transactions", async () => {
    const ctx = createContext({});
    const coinbase: TransactionMessage = {
      type: MessageType.TRANSACTION,
      height: 0,
      outputs: [{ pubkey: senderPubkeyHex, value: 50 }],
    };

    expect(validateTransaction(coinbase, ctx)).resolves.toBe(true);
  });

  test("throws INVALID_FORMAT for non-coinbase transactions without inputs", async () => {
    const ctx = createContext({});
    const malformedTx = {
      type: MessageType.TRANSACTION,
      outputs: [{ pubkey: senderPubkeyHex, value: 50 }],
    } as TransactionMessage;

    await expectProtocolError(
      validateTransaction(malformedTx, ctx),
      ErrorCode.INVALID_FORMAT,
    );
  });

  test("accepts a valid signed non-coinbase transaction", async () => {
    const ctx = createContext({ [PREV_TX_ID]: previousTx });
    const tx: TransactionMessage = {
      type: MessageType.TRANSACTION,
      inputs: [
        {
          outpoint: { txid: PREV_TX_ID, index: 0 },
          sig: null,
        },
      ],
      outputs: [{ pubkey: RECIPIENT_PUBKEY, value: 10 }],
    };

    tx.inputs![0]!.sig = await signTransaction(tx, senderPrivateKey);

    expect(validateTransaction(tx, ctx)).resolves.toBe(true);
  });
});
