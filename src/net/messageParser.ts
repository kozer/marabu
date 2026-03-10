import z from "zod";
import ProtocolError, { ErrorCode } from "@/protocol/error";
import {
  MessageSchema,
  type ConnectedPeerContext,
  type ValidMessage,
} from "@/protocol/types";
import { validateMessage } from "@/protocol/validator";
import { sendMessage } from "@/shared/utils";

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
    sendMessage(
      ctx.socket,
      new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        `Received message that is not valid JSON: ${error}`,
      ),
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
        sendMessage(
          ctx.socket,
          new ProtocolError(
            ErrorCode.INVALID_FORMAT,
            `Received message with invalid type`,
          ),
        );
      }
    }
    if (error instanceof ProtocolError) {
      ctx.logger.error(`Protocol validation failed: ${error.name}`);
      sendMessage(ctx.socket, error);
    } else {
      ctx.logger.error({ err: error }, "Unknown protocol message");

      sendMessage(
        ctx.socket,
        new ProtocolError(
          ErrorCode.INVALID_FORMAT,
          "Received message with invalid format",
        ),
      );
    }

    ctx.socket.end();
    return null;
  }
  return message;
}
