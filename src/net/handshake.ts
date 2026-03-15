import { MessageType, ErrorCode } from "@/protocol/types";
import ProtocolError from "@/protocol/error";
import { semver } from "bun";

export interface ConnectionState {
  hasHandshaked: boolean;
}

export function checkHandshake(message: any, state: ConnectionState): boolean {
  if (state.hasHandshaked) return true;

  if (message.type !== MessageType.HELLO) {
    throw new ProtocolError(
      ErrorCode.INVALID_HANDSHAKE,
      "First message must be a HELLO handshake",
    );
  }

  if (!semver.satisfies(message.version, "0.10.x")) {
    throw new ProtocolError(
      ErrorCode.INVALID_FORMAT,
      `Incompatible client version ${message.version}`,
    );
  }

  state.hasHandshaked = true;
  return true;
}
