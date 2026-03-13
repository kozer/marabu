import { beforeAll, describe, expect, test } from "bun:test";
import canonicalize from "canonicalize";
import * as ed from "@noble/ed25519";
import ProtocolError from "@/protocol/error";
import { ErrorCode, MessageType, ObjectType } from "@/protocol/types";
import type {
  ConnectedPeerContext,
  InputTransactionMessage,
  ObjectMessage,
  OutputTransactionMessage,
  TransactionMessage,
} from "./types";
import {
  validatePeers,
  validateOutpoints,
  validateRegularTx,
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

function wrapObject(object: TransactionMessage): ObjectMessage {
  return {
    type: MessageType.OBJECT,
    object,
  } as ObjectMessage;
}

function getTransactionObject(message: ObjectMessage): TransactionMessage {
  return message.object as TransactionMessage;
}

function createContext(
  objects: Record<string, ObjectMessage>,
): ConnectedPeerContext {
  return {
    id: "peer-1",
    socket: {} as any,
    peerManager: {} as any,
    logger,
    mapper: {
      put: async () => {},
      get: async (key: string) => objects[key] ?? null,
    } as any,
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
    expect((error as ProtocolError).name).toBe(code);
  }
}

let senderPrivateKey: Uint8Array;
let senderPubkeyHex: string;
let previousTxObject: ObjectMessage;

beforeAll(async () => {
  senderPrivateKey = new Uint8Array(Buffer.from("01".repeat(32), "hex"));
  const senderPubkey = await ed.getPublicKeyAsync(senderPrivateKey);
  senderPubkeyHex = toHex(senderPubkey);

  previousTxObject = wrapObject({
    type: ObjectType.TRANSACTION,
    height: 0,
    outputs: [{ pubkey: senderPubkeyHex, value: 50 }],
  });
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
    const ctx = createContext({ [PREV_TX_ID]: previousTxObject });
    const inputs: InputTransactionMessage[] = [
      {
        outpoint: { txid: PREV_TX_ID, index: 0 },
        sig: "aa".repeat(64),
      },
    ];

    const resolved = await validateOutpoints(inputs, ctx);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.resolvedOutput).toEqual(
      getTransactionObject(previousTxObject).outputs[0],
    );
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
    const ctx = createContext({ [PREV_TX_ID]: previousTxObject });
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
      ...createContext({ [PREV_TX_ID]: previousTxObject }),
      mapper: {
        put: async () => {},
        get: async (key: string) => {
          getObjectCalls += 1;
          return key === PREV_TX_ID ? previousTxObject : null;
        },
      } as any,
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
        resolvedOutput: getTransactionObject(previousTxObject).outputs[0]!,
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
        resolvedOutput: getTransactionObject(previousTxObject).outputs[0]!,
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
        resolvedOutput: getTransactionObject(previousTxObject).outputs[0]!,
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
      expect((error as ProtocolError).name).toBe(
        ErrorCode.INVALID_TX_CONSERVATION,
      );
    }
  });
});

describe("validateRegularTx", () => {
  test("accepts coinbase transactions", async () => {
    const ctx = createContext({});
    const coinbase: TransactionMessage = {
      type: ObjectType.TRANSACTION,
      height: 0,
      outputs: [{ pubkey: senderPubkeyHex, value: 50 }],
    };

    expect(validateRegularTx(coinbase, ctx)).resolves.toBe(true);
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
    const ctx = createContext({ [PREV_TX_ID]: previousTxObject });
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

    expect(validateRegularTx(tx, ctx)).resolves.toBe(true);
  });
});
