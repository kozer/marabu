import { describe, expect, test } from "bun:test";
import ObjectMapper from "@/storage/objectMapper";

function createMapper() {
  const db = {
    get: async (_id: string) => undefined,
    has: async (_id: string) => false,
  } as any;

  return new ObjectMapper(db);
}

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

describe("ObjectMapper", () => {
  test("computes the expected BLAKE2s id for the genesis block", () => {
    const mapper = createMapper();

    expect(mapper.id(GENESIS_BLOCK)).toBe(
      "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6",
    );
  });

  test("preserves the expected genesis target field", () => {
    expect(GENESIS_BLOCK.T).toBe(
      "00000000abc00000000000000000000000000000000000000000000000000000",
    );
  });

  test("produces the same id regardless of object key order", () => {
    const mapper = createMapper();

    const txA = {
      type: "transaction",
      inputs: [
        {
          outpoint: {
            txid: "11".repeat(32),
            index: 0,
          },
          sig: null,
        },
      ],
      outputs: [
        {
          pubkey: "22".repeat(32),
          value: 10,
        },
      ],
    } as any;

    const txB = {
      outputs: [
        {
          value: 10,
          pubkey: "22".repeat(32),
        },
      ],
      inputs: [
        {
          sig: null,
          outpoint: {
            index: 0,
            txid: "11".repeat(32),
          },
        },
      ],
      type: "transaction",
    } as any;

    expect(mapper.id(txA)).toBe(mapper.id(txB));
  });
});
