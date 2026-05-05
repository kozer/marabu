import { Socket } from "net";
import { isIP } from "node:net";
import canonicalize from "canonicalize";
import { SEPARATOR } from "./constants";
import type { ValidMessage } from "@/protocol/types";
import ProtocolError from "@/protocol/error";
import { bytesToHex } from "@noble/hashes/utils.js";
import { blake2s } from "@noble/hashes/blake2.js";

export type ParsedPeerAddress = {
  port: number;
  canonical: string;
  dialHost: string;
};

export function sendMessage(socket: Socket, message: ValidMessage | ProtocolError) {
  if (message instanceof ProtocolError) {
    socket.write(message.toMessage());
    return;
  }

  const messageStr = canonicalize(message) + SEPARATOR;
  socket.write(messageStr);
}

export function parseHost(str: string) {
  const trimmed = str.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return false;
  }
  const host = trimmed.slice(0, lastColon);
  const port = trimmed.slice(lastColon + 1);

  if (!host || !port) {
    return false;
  }

  const hasBracket = host.includes("[") || host.includes("]");
  const isBracketedHost = host.startsWith("[") && host.endsWith("]");
  if (hasBracket && !isBracketedHost) {
    return false;
  }

  if (!/^\d+$/.test(port)) {
    return false;
  }

  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
    return false;
  }

  return {
    host,
    port: portNum,
  };
}

export function parsePeerAddress(input: string): ParsedPeerAddress | null {
  const parsed = parseHost(input);
  if (!parsed) {
    return null;
  }

  const isBracketed = parsed.host.startsWith("[") && parsed.host.endsWith("]");
  let dialHost = isBracketed ? parsed.host.slice(1, -1) : parsed.host;

  if (dialHost.startsWith("::ffff:")) {
    const mapped = dialHost.slice(7);
    if (isIP(mapped) === 4) {
      dialHost = mapped;
    }
  }

  const canonicalHost = isIP(dialHost) === 6 ? `[${dialHost}]` : dialHost;

  return {
    port: parsed.port,
    canonical: `${canonicalHost}:${parsed.port}`,
    dialHost,
  };
}

export function normalizePeer(peer: string): string {
  return parsePeerAddress(peer)?.canonical ?? peer.trim();
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function hashObject(obj: unknown): string {
  const canonical = canonicalize(obj);
  if (!canonical) {
    return "";
  }

  return bytesToHex(blake2s(Buffer.from(canonical, "utf8")));
}

export function createThrottle(delayMs: number) {
  let lastCall = 0;
  let timer: NodeJS.Timeout | null = null;
  return (fn: () => Promise<void> | void) => {
    const now = Date.now();
    const remaining = delayMs - (now - lastCall);
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastCall = now;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        lastCall = Date.now();
        timer = null;
        fn();
      }, remaining);
    }
  };
}
