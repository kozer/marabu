import z from "zod";
import ProtocolError from "@/protocol/error";
import {
  MessageSchema,
  type Connection,
  type ValidMessage,
  ErrorCode,
} from "@/protocol/types";

export async function parseMessage(
  msg: string,
  connection: Connection,
): Promise<ValidMessage | null> {
  connection.log.info(`Message to parse ${msg.slice(0, 200)}...`);
  let message;
  try {
    message = JSON.parse(msg);
  } catch (error) {
    connection.log.error(`Error parsing message as JSON:`, message);
    await connection.ctx.peerManager.reportInvalidPeerMessage(
      connection.id,
      `Invalid JSON message: ${(error as Error).message}`,
    );
    throw new ProtocolError(
      ErrorCode.INVALID_FORMAT,
      `Received message that is not valid JSON: ${error}`,
    );
  }

  try {
    message = MessageSchema.parse(message);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const tree = z.treeifyError<ValidMessage>(
        error as z.ZodError<ValidMessage>,
      );
      if (tree.properties?.type?.errors?.includes("Invalid input")) {
        connection.log.error(`Message validation failed: Invalid message type`);
        await connection.ctx.peerManager.reportInvalidPeerMessage(
          connection.id,
          "INVALID_MESSAGE_TYPE",
        );

        throw new ProtocolError(
          ErrorCode.INVALID_FORMAT,
          `Received message with invalid type`,
        );
      }
    }
    if (error instanceof ProtocolError) {
      connection.log.error(`Protocol validation failed: ${error.name}`);
      await connection.ctx.peerManager.reportInvalidPeerMessage(connection.id, error.name);
      throw error;
    } else {
      connection.log.error({ err: error }, "Unknown protocol message");
      await connection.ctx.peerManager.reportInvalidPeerMessage(
        connection.id,
        "UNKNOWN_PROTOCOL_MESSAGE",
      );

      throw new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        "Received message with unknown format",
      );
    }
  }
  return message;
}
