import { describe, expect, test } from "bun:test";
import {
  normalizePeer,
  parseHost,
  parsePeerAddress,
  topologicalSort,
  hashObject as id,
} from "@/shared/utils";
import type { TransactionMessage } from "@/protocol/types";
import { ObjectType } from "@/protocol/types";

// ---- topologicalSort ----

let txCounter = 0;
function tx(overrides: Partial<Omit<TransactionMessage, "type">> = {}): TransactionMessage {
  txCounter++;
  return {
    type: ObjectType.TRANSACTION,
    outputs: [
      { pubkey: "00".repeat(31) + txCounter.toString().padStart(2, "0"), value: 100 + txCounter },
    ],
    ...overrides,
  } as TransactionMessage;
}

describe("parseHost", () => {
  test("should parse valid IPv4:port", () => {
    const result = parseHost("192.168.1.1:8080");
    expect(result).toEqual({ host: "192.168.1.1", port: 8080 });
  });

  test("should parse valid hostname:port", () => {
    const result = parseHost("example.com:8080");
    expect(result).toEqual({ host: "example.com", port: 8080 });
  });

  test("should parse IPv6 in brackets", () => {
    const result = parseHost("[::1]:8080");
    expect(result).toEqual({ host: "[::1]", port: 8080 });
  });

  test("should handle trailing newline \\n", () => {
    const result = parseHost("192.168.1.1:8080\n");
    expect(result).toEqual({ host: "192.168.1.1", port: 8080 });
  });

  test("should handle trailing carriage return \\r", () => {
    const result = parseHost("192.168.1.1:8080\r");
    expect(result).toEqual({ host: "192.168.1.1", port: 8080 });
  });

  test("should handle Windows line endings \\r\\n", () => {
    const result = parseHost("192.168.1.1:8080\r\n");
    expect(result).toEqual({ host: "192.168.1.1", port: 8080 });
  });

  test("should handle leading newline \\n", () => {
    const result = parseHost("\n192.168.1.1:8080");
    expect(result).toEqual({ host: "192.168.1.1", port: 8080 });
  });

  test("should return false for no colon", () => {
    const result = parseHost("192.168.1.1");
    expect(result).toBe(false);
  });

  test("should return false for empty string", () => {
    const result = parseHost("");
    expect(result).toBe(false);
  });

  test("should return false for empty host", () => {
    const result = parseHost(":8080");
    expect(result).toBe(false);
  });

  test("should return false for empty port", () => {
    const result = parseHost("192.168.1.1:");
    expect(result).toBe(false);
  });

  test("should return false for only whitespace", () => {
    const result = parseHost("   ");
    expect(result).toBe(false);
  });

  test("should return false for non-numeric port", () => {
    const result = parseHost("192.168.1.1:abc");
    expect(result).toBe(false);
  });

  test("should return false for port with junk suffix", () => {
    const result = parseHost("192.168.1.1:8080abc");
    expect(result).toBe(false);
  });

  test("should return false for out-of-range port", () => {
    const result = parseHost("192.168.1.1:65536");
    expect(result).toBe(false);
  });

  test("should return false for malformed bracket host", () => {
    const result = parseHost("[::1:8080");
    expect(result).toBe(false);
  });

  test("should handle localhost with trailing newline", () => {
    const result = parseHost("localhost:8080\n");
    expect(result).toEqual({ host: "localhost", port: 8080 });
  });

  test("should handle hostname with subdomain and newline", () => {
    const result = parseHost("node1.example.com:8080\n");
    expect(result).toEqual({ host: "node1.example.com", port: 8080 });
  });
});

describe("parsePeerAddress", () => {
  test("returns canonical and dial host for IPv4", () => {
    const result = parsePeerAddress("192.168.1.1:8080");

    expect(result).toEqual({
      port: 8080,
      canonical: "192.168.1.1:8080",
      dialHost: "192.168.1.1",
    });
  });

  test("returns canonical bracketed IPv6 and unbracketed dial host", () => {
    const result = parsePeerAddress("[::1]:8080");

    expect(result).toEqual({
      port: 8080,
      canonical: "[::1]:8080",
      dialHost: "::1",
    });
  });

  test("normalizes IPv4-mapped IPv6", () => {
    const result = parsePeerAddress("[::ffff:127.0.0.1]:8080");

    expect(result).toEqual({
      port: 8080,
      canonical: "127.0.0.1:8080",
      dialHost: "127.0.0.1",
    });
  });

  test("returns null for invalid peer", () => {
    expect(parsePeerAddress("bad-peer")).toBeNull();
  });
});

describe("normalizePeer", () => {
  test("returns canonical peer address", () => {
    expect(normalizePeer("[::1]:8080\n")).toBe("[::1]:8080");
  });
});

describe("topologicalSort", () => {
  test("empty array returns empty", () => {
    expect(topologicalSort([])).toEqual([]);
  });

  test("single tx with no inputs", () => {
    const a = tx();
    expect(topologicalSort([a])).toEqual([a]);
  });

  test("two independent txs", () => {
    const a = tx();
    const b = tx();
    const result = topologicalSort([a, b]);
    expect(result).toHaveLength(2);
    expect(result).toContain(a);
    expect(result).toContain(b);
  });

  test("chain A -> B -> C", () => {
    const a = tx();
    const b = tx({ inputs: [{ outpoint: { txid: id(a), index: 0 }, sig: null }] });
    const c = tx({ inputs: [{ outpoint: { txid: id(b), index: 0 }, sig: null }] });
    const result = topologicalSort([c, a, b]);
    const ids = result.map(id);
    expect(ids.indexOf(id(a))).toBeLessThan(ids.indexOf(id(b)));
    expect(ids.indexOf(id(b))).toBeLessThan(ids.indexOf(id(c)));
  });

  test("diamond: D depends on B and C, both depend on A", () => {
    const a = tx();
    const b = tx({ inputs: [{ outpoint: { txid: id(a), index: 0 }, sig: null }] });
    const c = tx({ inputs: [{ outpoint: { txid: id(a), index: 0 }, sig: null }] });
    const d = tx({
      inputs: [
        { outpoint: { txid: id(b), index: 0 }, sig: null },
        { outpoint: { txid: id(c), index: 0 }, sig: null },
      ],
    });
    const result = topologicalSort([d, b, c, a]);
    const ids = result.map(id);
    expect(ids.indexOf(id(a))).toBeLessThan(ids.indexOf(id(b)));
    expect(ids.indexOf(id(a))).toBeLessThan(ids.indexOf(id(c)));
    expect(ids.indexOf(id(b))).toBeLessThan(ids.indexOf(id(d)));
    expect(ids.indexOf(id(c))).toBeLessThan(ids.indexOf(id(d)));
  });

  test("tx depends on confirmed UTXO (not pending)", () => {
    const a = tx();
    const b = tx({
      inputs: [{ outpoint: { txid: "00".repeat(32), index: 0 }, sig: null }],
    });
    const result = topologicalSort([b, a]);
    expect(result).toHaveLength(2);
    expect(result).toContain(a);
    expect(result).toContain(b);
  });

  test("tx with mix of pending and confirmed deps", () => {
    const a = tx();
    const b = tx({
      inputs: [
        { outpoint: { txid: "00".repeat(32), index: 0 }, sig: null },
        { outpoint: { txid: id(a), index: 0 }, sig: null },
      ],
    });
    const result = topologicalSort([b, a]);
    const ids = result.map(id);
    expect(ids.indexOf(id(a))).toBeLessThan(ids.indexOf(id(b)));
  });

  test("cycle: mutual deps via missing pending tx → unresolvable txs dropped", () => {
    const cx = tx();
    const cy = tx({ inputs: [{ outpoint: { txid: id(cx), index: 0 }, sig: null }] });
    const result = topologicalSort([cy, cx]);
    expect(result).toHaveLength(2);
    expect(id(result[0]!)).toBe(id(cx));
    expect(id(result[1]!)).toBe(id(cy));
  });

  test("cb txs come before txs with explicit inputs", () => {
    const a = tx();
    const b = tx({ inputs: [] });
    const c = tx({ inputs: [{ outpoint: { txid: id(a), index: 0 }, sig: null }] }); // depends on a
    const result = topologicalSort([c, b, a]);
    const ids = result.map(id);
    expect(ids.indexOf(id(a))).toBeLessThan(ids.indexOf(id(c)));
    expect(ids.indexOf(id(b))).toBeLessThan(ids.indexOf(id(c)));
    expect(result).toHaveLength(3);
  });

  test("returns all txs when no graph edges", () => {
    const a = tx({
      inputs: [{ outpoint: { txid: "aa".repeat(32), index: 0 }, sig: null }],
    });
    const b = tx({
      inputs: [{ outpoint: { txid: "bb".repeat(32), index: 0 }, sig: null }],
    });
    const result = topologicalSort([a, b]);
    expect(result).toHaveLength(2);
  });
});
