import { Socket } from "net";
import canonicalize from "canonicalize";
import { SEPARATOR } from "./constants";
import type { ValidMessage } from "./types";

export function sendMessage(socket: Socket, message: ValidMessage) {
  const messageStr = canonicalize(message) + SEPARATOR;
  socket.write(messageStr);
}

export function validateHost(str: string) {
  const { port } = parseHost(str) || {};
  if (!port) {
    return false;
  }
  return Number.isInteger(port) && port > 0 && port <= 65535;
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

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
