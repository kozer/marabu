import ProtocolError from "@/protocol/error";
import { type PeersMessage, ErrorCode } from "@/protocol/types";
import { parsePeerAddress } from "@/shared/utils";
export function validatePeers(message: PeersMessage): boolean {
  for (const peer of message.peers) {
    if (!parsePeerAddress(peer)) {
      throw new ProtocolError(ErrorCode.INVALID_FORMAT, "Received message with invalid format");
    }
  }
  return true;
}
