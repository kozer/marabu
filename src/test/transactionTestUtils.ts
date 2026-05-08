import * as ed from "@noble/ed25519";

export function createTestPrivateKey(hex = "01".repeat(32)): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export async function getPublicKeyHex(privateKey: Uint8Array): Promise<string> {
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return Buffer.from(publicKey).toString("hex");
}
