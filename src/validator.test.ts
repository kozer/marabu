import { expect, test, describe } from "bun:test";
import { validateHost } from "./validator";

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
