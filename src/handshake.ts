import { Socket } from "net";
import { MessageType } from "./constants";
import ProtocolError, { ErrorCode } from "./error";
import { semver } from "bun";
import { sendMessage } from "./utils";

export interface ConnectionState {
  hasHandshaked: boolean;
}

export function checkHandshake(
  message: any,
  socket: Socket,
  state: ConnectionState,
): boolean {
  if (state.hasHandshaked) return true;

  if (message.type !== MessageType.HELLO) {
    sendMessage(
      socket,
      new ProtocolError(
        ErrorCode.INVALID_HANDSHAKE,
        "Received message before handshake",
      ),
    );
    socket.end();
    return false;
  }

  if (!semver.satisfies(message.version, "0.10.x")) {
    sendMessage(
      socket,
      new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        `Incompatible client version ${message.version}`,
      ),
    );
    socket.end();
    return false;
  }

  state.hasHandshaked = true;
  return true;
}
