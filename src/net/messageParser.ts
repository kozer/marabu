import z from "zod";
import ProtocolError from "@/protocol/error";
import {
  MessageSchema,
  type ValidMessage,
  ErrorCode,
  type ConnectedPeerContext,
} from "@/protocol/types";

export async function parseMessage(
  msg: string,
  ctx: ConnectedPeerContext,
): Promise<ValidMessage | null> {
  ctx.logger.info(`Message to parse ${msg.slice(0, 400)}...`);
  let message;
  try {
    message = JSON.parse(msg);
  } catch (error) {
    ctx.logger.error(`Error parsing message as JSON:`, message);
    await ctx.peerManager.reportInvalidPeerMessage(
      ctx.id,
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
    ctx.logger.info(`Message type: ${message?.type}`);
    if (error instanceof z.ZodError) {
      const tree = z.treeifyError<ValidMessage>(error as z.ZodError<ValidMessage>);
      if (tree.properties?.type?.errors?.includes("Invalid input")) {
        ctx.logger.error(`Message validation failed: Invalid message type`);
        await ctx.peerManager.reportInvalidPeerMessage(ctx.id, "INVALID_MESSAGE_TYPE");

        throw new ProtocolError(ErrorCode.INVALID_FORMAT, `Received message with invalid type`);
      }
    }
    if (error instanceof ProtocolError) {
      ctx.logger.error(`Protocol validation failed: ${error.name}`);
      await ctx.peerManager.reportInvalidPeerMessage(ctx.id, error.name);
      throw error;
    } else {
      ctx.logger.error({ err: error }, "Unknown protocol message");
      await ctx.peerManager.reportInvalidPeerMessage(ctx.id, "UNKNOWN_PROTOCOL_MESSAGE");

      throw new ProtocolError(ErrorCode.INVALID_FORMAT, "Received message with unknown format");
    }
  }
  return message;
}
