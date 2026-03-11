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

  constructor(
    private readonly ctx: ConnectedPeerContext,
    private readonly direction: "inbound" | "outbound",
  ) {
    if (this.direction === "outbound") {
      ctx.peerManager.registerOutboundConnection(this);
    }
    if (this.direction === "inbound") {
      ctx.peerManager.registerInboundConnection(this);
    }
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

    this.ctx.socket.on("error", async (err) => {
      if (this.ctx.peerManager.hasOutboundConnection(this.id)) {
        await this.ctx.peerManager.onDialFail(this.id);

        if (
          err.message.includes("ENOTFOUND") ||
          err.message.includes("EAI_AGAIN")
        ) {
          this.ctx.logger.warn(
            `DNS resolution failed for ${this.id}: ${err.message}. Blacklisting for ${DNS_BLACKLIST_TTL_MS / 1000} seconds.`,
          );
          this.ctx.peerManager.blacklistPeer(
            this.id,
            DNS_BLACKLIST_TTL_MS,
            err.message,
          );
          this.ctx.socket.destroy();
          return;
        }
      }
      this.ctx.peerManager.unregisterConnection(this.id);
      this.ctx.logger.debug(
        `Socket produced error for ${this.id}: ${err.message}`,
      );
      this.ctx.logger.warn(`Failed to connect to ${this.id}: ${err.message}`);
    });

    this.ctx.socket.on("timeout", async () => {
      if (this.ctx.peerManager.hasOutboundConnection(this.id)) {
        void this.ctx.peerManager.onDialFail(this.id);
        this.ctx.socket.destroy();
        return;
      }
      this.ctx.peerManager.unregisterConnection(this.id);
      this.ctx.socket.destroy();
    });

    this.ctx.socket.on("finish", () => {
      this.ctx.peerManager.unregisterConnection(this.id);
      this.ctx.logger.debug(`Socket finished for ${this.id}`);
    });
  }

  private sendInitialMessages(): void {
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
