import { DNS_BLACKLIST_TTL_MS, SEPARATOR } from "@/shared/constants";
import ProtocolError from "@/protocol/error";
import { checkHandshake, type ConnectionState } from "@/net/handshake";
import { messageHandlers } from "@/net/messageHandlers";
import { parseMessage } from "@/net/messageParser";
import {
  MessageType,
  ErrorCode,
  type ConnectedPeerContext,
  type ValidMessage,
} from "@/protocol/types";
import { sendMessage } from "@/shared/utils";

export class PeerConnection {
  private buffer = "";
  private readonly state: ConnectionState = { hasHandshaked: false };
  private initialMessagesSent = false;

  constructor(private readonly ctx: ConnectedPeerContext) {
    this.attachSocketHandlers();
  }

  get id(): string {
    return this.ctx.id;
  }

  get context(): ConnectedPeerContext {
    return this.ctx;
  }

  send(message: ValidMessage | ProtocolError): void {
    sendMessage(this.ctx.socket, message);
  }

  private attachSocketHandlers(): void {
    if (this.ctx.socket.readyState === "open") {
      this.sendInitialMessages();
    } else {
      this.ctx.socket.on("connect", () => this.sendInitialMessages());
    }
    this.ctx.socket.on("data", (data) => {
      void this.handleData(data.toString());
    });

    this.ctx.socket.on("end", () => {
      this.ctx.logger.info("Closing connection with the client");
      this.ctx.peerManager.unregisterConnection(this.id);
    });

    this.ctx.socket.on("error", (err) => {
      this.ctx.logger.info(`Error: ${err}`);
      this.ctx.peerManager.unregisterConnection(this.id);
      this.ctx.peerManager.onDialFail(this.id);
      if (
        err.message.includes("ENOTFOUND") ||
        err.message.includes("EAI_AGAIN")
      ) {
        this.ctx.peerManager.blacklistPeer(
          this.id,
          DNS_BLACKLIST_TTL_MS,
          err.message,
        );
        return;
      }
      this.send(
        new ProtocolError(
          ErrorCode.INTERNAL_ERROR,
          `Socket produced error: ${err.message}`,
        ),
      );
    });

    this.ctx.socket.on("timeout", () => {
      this.ctx.peerManager.onDialFail(this.id);
      this.send(
        new ProtocolError(ErrorCode.INTERNAL_ERROR, `Socket timed out`),
      );
    });

    this.ctx.socket.on("finish", () => {
      this.ctx.peerManager.unregisterConnection(this.id);
      this.send(new ProtocolError(ErrorCode.INTERNAL_ERROR, `Socket finished`));
      this.ctx.socket.end();
    });
  }

  private sendInitialMessages(): void {
    if (this.initialMessagesSent) {
      return;
    }
    this.initialMessagesSent = true;
    this.send({
      type: MessageType.HELLO,
      version: "0.10.0",
      agent: "Subzero node client",
    });

    this.send({
      type: MessageType.GET_PEERS,
    });
  }

  private async handleData(chunk: string): Promise<void> {
    this.buffer += chunk;
    const messages = this.buffer.split(SEPARATOR);
    this.buffer = messages.pop() || "";

    for (const rawMessage of messages) {
      if (!rawMessage.trim()) {
        continue;
      }

      const message = await parseMessage(rawMessage, this.ctx);
      if (!message) {
        return;
      }

      if (!checkHandshake(message, this.ctx.socket, this.state)) {
        return;
      }

      const handler = messageHandlers[message.type];
      if (!handler) {
        this.ctx.logger.error(
          `No handler found for message type: ${message.type}`,
        );
        continue;
      }

      try {
        await handler(message, this.ctx);
      } catch (error) {
        this.ctx.logger.error(
          { err: error, type: message.type },
          "Message handler failed",
        );
        this.send(
          new ProtocolError(
            ErrorCode.INTERNAL_ERROR,
            `Failed to handle ${message.type} message`,
          ),
        );
        this.ctx.socket.end();
        return;
      }

      this.ctx.logger.info(
        { type: message.type },
        `[${this.ctx.id}]: Received message`,
      );
    }
  }
}
