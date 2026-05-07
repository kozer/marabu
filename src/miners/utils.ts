import { TARGET, ObjectType } from "../protocol/types";
import { agent } from "../shared/constants";
import canonicalize from "canonicalize";

export const NONCE_WIDTH = 64;
export const NONCE_PLACEHOLDER = "0".repeat(NONCE_WIDTH);

export function buildTemplate(
  tip: string,
  txids: string[],
): { buf: Buffer; nonceOffset: number; created: number; block: any } {
  const created = Math.floor(Date.now() / 1000);
  const block = {
    type: ObjectType.BLOCK,
    T: TARGET,
    created,
    miner: agent,
    nonce: NONCE_PLACEHOLDER,
    previd: tip,
    txids,
  };
  const canonical = canonicalize(block)!;
  const buf = Buffer.from(canonical, "utf8");
  const nonceOffset = canonical.indexOf(NONCE_PLACEHOLDER);
  return { buf, nonceOffset, created, block };
}
