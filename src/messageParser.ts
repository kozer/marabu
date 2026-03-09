import z from "zod";
import ProtocolError, { ErrorCode } from "./error";
import {
  MessageSchema,
  type ConnectedPeerContext,
  type ValidMessage,
} from "./types";
import { validateMessage } from "./validator";

export async function parseMessage(
  msg: string,
  ctx: ConnectedPeerContext,
): Promise<ValidMessage | null> {
  ctx.logger.info(`Message to parse ${msg.slice(0, 200)}...`);
  let message;
  try {
    message = JSON.parse(msg);
  } catch (error) {
    ctx.logger.error(`Error parsing message as JSON:`, message);
    ctx.socket.write(
      new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        `Received message that is not valid JSON: ${error}`,
      ).toMessage(),
    );
    ctx.socket.end();
    return null;
  }

  try {
    message = MessageSchema.parse(message);
    await validateMessage(message, ctx);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const tree = z.treeifyError<ValidMessage>(
        error as z.ZodError<ValidMessage>,
      );
      if (tree.properties?.type?.errors?.includes("Invalid input")) {
        ctx.logger.error(`Message validation failed: Invalid message type`);
        ctx.socket.write(
          new ProtocolError(
            ErrorCode.INVALID_FORMAT,
            `Received message with invalid type`,
          ).toMessage(),
        );
      }
    }
    if (error instanceof ProtocolError) {
      ctx.logger.error(`Protocol validation failed: ${error.code}`);
      ctx.socket.write(error.toMessage());
    } else {
      ctx.logger.error({ err: error }, "Unknown protocol message");

      ctx.socket.write(
        new ProtocolError(
          ErrorCode.INVALID_FORMAT,
          "Received message with invalid format",
        ).toMessage(),
      );
    }

    ctx.socket.end();
    return null;
  }
  return message;
}
