import canonicalize from "canonicalize";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

class ObjectMapper {
  public static toId(obj: unknown): string {
    const canonical = canonicalize(obj);
    if (!canonical) {
      throw new Error("Failed to canonicalize object");
    }

    return bytesToHex(blake2s(Buffer.from(canonical, "utf8")));
  }
}
export default ObjectMapper;
