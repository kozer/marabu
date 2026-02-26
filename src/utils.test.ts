import { expect, test, describe } from "bun:test";
import { parseHost, validateHost } from "./utils";

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
    expect(result).toEqual({ host: "192.168.1.1", port: NaN });
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
