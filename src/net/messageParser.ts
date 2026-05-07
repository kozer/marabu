import z from "zod";
import ProtocolError from "@/protocol/error";
import {
  MessageSchema,
  ErrorCode,
  type ConnectedPeerContext,
  type ValidMessage,
} from "@/protocol/types";

export async function parseMessage(
  msg: string,
  ctx: ConnectedPeerContext,
): Promise<ValidMessage | null> {
  ctx.logger.trace(`Message to parse ${msg.slice(0, 400)}...`);
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
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((iss) => `${iss.path.join(".")}: ${iss.message}${iss.input !== undefined ? ` (got: ${JSON.stringify(iss.input)})` : ""}`)
        .join(" | ");

      const tree = z.treeifyError(error);
      ctx.logger.error(
        { validationTree: tree, msg_type: message?.type },
        `Protocol Validation Failed: ${issues}`,
      );

      const failedType = error.issues.some(
        (iss) => iss.path[iss.path.length - 1] === "type" && iss.code === "invalid_union"
      );
      if (failedType) {
        await ctx.peerManager.reportInvalidPeerMessage(ctx.id, "INVALID_MESSAGE_TYPE");
        throw new ProtocolError(ErrorCode.INVALID_FORMAT, "Received message with invalid type");
      }

      await ctx.peerManager.reportInvalidPeerMessage(ctx.id, "INVALID_MESSAGE_FIELDS");
      throw new ProtocolError(ErrorCode.INVALID_FORMAT, `Validation failed: ${issues}`);
    }
    if (error instanceof ProtocolError) {
      ctx.logger.error(`Protocol validation failed: ${error.name}`);
      await ctx.peerManager.reportInvalidPeerMessage(ctx.id, error.name);
      throw error;
    }

    ctx.logger.error({ err: error }, "Unknown protocol message");
    await ctx.peerManager.reportInvalidPeerMessage(ctx.id, "UNKNOWN_PROTOCOL_MESSAGE");
    throw new ProtocolError(ErrorCode.INVALID_FORMAT, "Received message with unknown format");
  }
  return message;
}
