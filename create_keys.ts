import * as ed from "@noble/ed25519";
const { secretKey, publicKey } = await ed.keygenAsync();

const secretK = Buffer.from(secretKey).toString("hex");
const publicK = Buffer.from(publicKey).toString("hex");

// 4. Write keys to files
await Bun.write("keys.json", JSON.stringify({ secretKey: secretK, publicKey: publicK }));

console.log("Keys created successfully!");
