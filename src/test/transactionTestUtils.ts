import canonicalize from "canonicalize";
import * as ed from "@noble/ed25519";
import type { TransactionMessage } from "@/protocol/types";

export function createTestPrivateKey(hex = "01".repeat(32)): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export async function getPublicKeyHex(
  privateKey: Uint8Array,
): Promise<string> {
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return Buffer.from(publicKey).toString("hex");
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
