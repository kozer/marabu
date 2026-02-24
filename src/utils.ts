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
  const lastColon = str.lastIndexOf(":");
  if (lastColon === -1) {
    return false;
  }
  const host = str.slice(0, lastColon);
  const port = str.slice(lastColon + 1);

  if (!host || !port) {
    return false;
  }
  const portNum = parseInt(port, 10);
  return {
    host,
    port: portNum,
  };
}
