import canonicalize from "canonicalize";
// Blake2 cannot be used due to compatibility issues with bun.
import { createHash } from "node:crypto";

class ObjectMapper {
  public static toId(obj: unknown): string {
    const canonical = canonicalize(obj);
    if (!canonical) {
      throw new Error("Failed to canonicalize object");
    }

    return createHash("blake2s256").update(canonical, "utf8").digest("hex");
  }
}
export default ObjectMapper;
