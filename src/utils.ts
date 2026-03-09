import { Socket } from "net";
import { isIP } from "node:net";
import canonicalize from "canonicalize";
import { SEPARATOR } from "./constants";
import type { ValidMessage } from "./types";
import ProtocolError from "./error";

export function sendMessage(
  socket: Socket,
  message: ValidMessage | ProtocolError,
) {
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
  const portNum = parseInt(port, 10);
  return {
    host,
    port: portNum,
  };
}

export function normalizePeer(peer: string): string {
  const trimmed = peer.trim();
  const parsed = parseHost(trimmed);
  if (!parsed || !Number.isFinite(parsed.port)) {
    return trimmed;
  }

  const rawHost = parsed.host;
  const isBracketed = rawHost.startsWith("[") && rawHost.endsWith("]");
  const host = isBracketed ? rawHost.slice(1, -1) : rawHost;

  if (host.startsWith("::ffff:")) {
    const mapped = host.slice(7);
    if (isIP(mapped) === 4) {
      return `${mapped}:${parsed.port}`;
    }
  }

  const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
  return `${formattedHost}:${parsed.port}`;
}

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
