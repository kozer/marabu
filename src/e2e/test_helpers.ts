import { Socket } from "net";
import * as ed from "@noble/ed25519";
import { rmSync } from "fs";
import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SEPARATOR, SERVER_HOST, SERVER_PORT } from "@/shared/constants";
import { ObjectType, TARGET } from "@/protocol/types";

// ── Object ID ───────────────────────────────────────────

export function oid(obj: unknown): string {
  const canonical = canonicalize(obj as object);
  if (!canonical) throw new Error("Failed to canonicalize object");
  return bytesToHex(blake2s(Buffer.from(canonical, "utf-8")));
}

// ── Socket helpers ──────────────────────────────────────

export function send(sock: Socket, msg: unknown) {
  sock.write(canonicalize(msg as object)! + SEPARATOR);
}

export function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    sock.connect(SERVER_PORT, SERVER_HOST, () => resolve(sock));
    sock.on("error", reject);
  });
}

export function collectMessages(
  sock: Socket,
  timeoutMs: number,
  objectStore?: Map<string, unknown>,
  until?: (msg: any) => boolean,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let buf = "";
  let resolved = false;

  return new Promise((resolve) => {
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sock.removeListener("data", onData);
      sock.removeListener("close", cleanup);
      sock.removeListener("error", cleanup);
      resolve(messages);
    };

    // 1. Define the primary data handler
    const onData = (data: Buffer) => {
      buf += data.toString();
      const parts = buf.split(SEPARATOR);
      buf = parts.pop()!;
      for (const raw of parts) {
        if (!raw.trim()) continue;
        try {
          const msg = JSON.parse(raw);
          messages.push(msg);
          // Auto-responder logic for tests (if objectStore is provided)
          if (
            objectStore &&
            msg.type === "getobject" &&
            msg.objectid &&
            objectStore.has(msg.objectid)
          ) {
            send(sock, { type: "object", object: objectStore.get(msg.objectid) });
          }
        } catch {}
      }
      if (until) {
        for (const msg of messages) {
          if (until(msg)) {
            cleanup();
            return;
          }
        }
      }
    };

    const timer = setTimeout(cleanup, timeoutMs);

    sock.on("data", onData);
    sock.once("close", cleanup);
    sock.once("error", cleanup);
  });
}

export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── DB cleanup ──────────────────────────────────────────

export function cleanDb(dbPath: string, peersFile: string) {
  try {
    rmSync(dbPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    rmSync(peersFile, { force: true });
  } catch {
    /* ignore */
  }
}

// ── Builders ────────────────────────────────────────────

export function nonce(n: number): string {
  return "0".repeat(63) + n.toString(16);
}

export function buildBlock(fields: {
  created: number;
  miner: string;
  nonce: string;
  note: string;
  previd: string | null;
  txids: string[];
}) {
  return { T: TARGET, ...fields, type: ObjectType.BLOCK };
}

export function coinbase(height: number, pubkey: string, value: number) {
  return { type: ObjectType.TRANSACTION, height, outputs: [{ pubkey, value }] };
}

export async function signTx(tx: Record<string, unknown>, key: Uint8Array): Promise<string> {
  const txCopy = {
    ...tx,
    inputs: (tx.inputs as Array<Record<string, unknown>>)?.map((i) => ({ ...i, sig: null })),
  };
  const msg = new Uint8Array(Buffer.from(canonicalize(txCopy)!, "utf-8"));
  return bytesToHex(await ed.signAsync(msg, key));
}

export async function buildSpend(
  sourceTxid: string,
  pubkey: string,
  value: number,
  key: Uint8Array,
) {
  const tx: Record<string, unknown> = {
    type: ObjectType.TRANSACTION,
    inputs: [{ outpoint: { txid: sourceTxid, index: 0 }, sig: null }],
    outputs: [{ pubkey, value }],
  };
  (tx.inputs as Array<Record<string, unknown>>)[0]!.sig = await signTx(tx, key);
  return tx;
}
