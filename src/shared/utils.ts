import { Socket } from "net";
import * as ed from "@noble/ed25519";
import { isIP } from "node:net";
import canonicalize from "canonicalize";
import { SEPARATOR } from "./constants";
import type { ValidMessage } from "@/protocol/types";
import type { TransactionMessage } from "@/protocol/types";
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

export function topologicalSort(txs: TransactionMessage[]): TransactionMessage[] {
  //https://medium.com/@konduruharish/topological-sort-in-typescript-and-c-6d5ecc4bad95
  const sortedTxs: TransactionMessage[] = [];
  const txMap = new Map<string, TransactionMessage>(txs.map((tx) => [hashObject(tx), tx]));
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  txs.forEach((tx) => inDegree.set(hashObject(tx), 0));

  for (let tx of txs) {
    const txHash = hashObject(tx);
    for (let input of tx?.inputs ?? []) {
      const outpointId = input.outpoint.txid;
      if (!txMap.has(outpointId)) {
        continue;
      }
      if (!adjList.has(outpointId)) {
        adjList.set(outpointId, []);
      }
      const item = adjList.get(outpointId)!;
      item.push(txHash);
      adjList.set(outpointId, item);
    }
  }
  for (let edge of adjList.values().flatMap((x) => x)) {
    if (inDegree.has(edge)) {
      inDegree.set(edge, inDegree.get(edge)! + 1);
    } else {
      inDegree.set(edge, 1);
    }
  }

  let queue: string[] = [];
  for (let [vertex, degree] of inDegree) {
    if (degree == 0) {
      // Add vertices with inDegree 0 to the queue
      queue.push(vertex);
    }
  }
  while (queue.length > 0) {
    let current = queue.shift()!;
    sortedTxs.push(txMap.get(current)!);
    if (adjList.has(current)) {
      for (let edge of adjList.get(current)!) {
        const degree = inDegree.get(edge);
        if (degree && degree! > 0) {
          inDegree.set(edge, degree - 1);
          if (degree - 1 == 0) {
            queue.push(edge);
          }
        }
      }
    }
  }

  return sortedTxs;
}

export async function signTransaction(
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
    throw new Error("Failed to canonicalize transaction for signing");
  }

  const msgBytes = new Uint8Array(Buffer.from(canonical, "utf-8"));
  const sig = await ed.signAsync(msgBytes, privateKey);
  return Buffer.from(sig).toString("hex");
}
