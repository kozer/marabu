import ProtocolError, { ErrorCode } from "./error";
import { Socket } from "net";
import { MessageSchema, type ValidMessage } from "./types";

export function parseMessage(
  msg: string,
  socket: Socket,
  logger: any,
): ValidMessage | null {
  logger.info(`Message to parse ${msg}`);
  let message;
  try {
    message = JSON.parse(msg);
  } catch (error) {
    logger.error(`Error parsing message as JSON:`, message);
    socket.write(
      new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        `Received message that is not valid JSON: ${error}`,
      ).toMessage(),
    );
    socket.end();
    return null;
  }

  try {
    message = MessageSchema.parse(message);
  } catch (_) {
    logger.error(`Unknown protocol message`, message);
    socket.write(
      new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        `Received message with invalid format`,
      ).toMessage(),
    );
    socket.end();
    return null;
  }
  return message;
}
