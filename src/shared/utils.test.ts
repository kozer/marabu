import { expect, test, describe } from "bun:test";
import { parseHost } from "@/shared/utils";

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
