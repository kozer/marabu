import { Socket } from "net";
import {
  agent,
  MESSAGE_RATE_LIMIT_PER_SEC,
  MESSAGE_RATE_WINDOW_MS,
  SEPARATOR,
} from "@/shared/constants";
import ProtocolError, { MultiProtocolError } from "@/protocol/error";
import { checkHandshake, type ConnectionState } from "@/net/handshake";
import { parseMessage } from "@/net/messageParser";
import {
  MessageType,
  ErrorCode,
  ConnectionDirection,
  type ConnectedPeerContext,
  type PeerContext,
  type Connection,
  type ValidMessage,
} from "@/protocol/types";
import { sendMessage } from "@/shared/utils";

export class PeerConnection implements Connection {
  private buffer = "";
  private readonly state: ConnectionState = { hasHandshaked: false };
  private msgCount = 0;
  private msgWindowStart = Date.now();

  constructor(
    private readonly socket: Socket,
    private readonly _ctx: ConnectedPeerContext,
    private readonly direction: ConnectionDirection,
  ) {
    this.attachSocketHandlers();
  }

  get id(): string {
    return this._ctx.id;
  }

  get log(): PeerContext["logger"] {
    return this._ctx.logger;
  }

  send(message: ValidMessage | ProtocolError): void {
    if (this.socket.destroyed || !this.socket.writable) return;
    this.log.trace(
      `Sending message to ${this.id}: ${message.type || (message as ProtocolError).name}`,
    );
    sendMessage(this.socket, message);
  }

  close(): void {
    if (this.socket.destroyed) return;
    this.socket.end();
  }

  private onConnect(): void {
    if (this.direction === ConnectionDirection.INBOUND) {
      this._ctx.peerManager.registerInboundConnection(this);
    }
    if (this.direction === ConnectionDirection.OUTBOUND) {
      this._ctx.peerManager.registerOutboundConnection(this);
    }
    this.socket.setTimeout(0);
    this.sendInitialMessages();
  }

  private attachSocketHandlers(): void {
    if (this.socket.readyState === "open") {
      this.onConnect();
    } else {
      this.socket.on("connect", () => this.onConnect());
    }
    this.socket.on("data", (data) => {
      this.handleData(data.toString());
    });
    this.socket.on("close", () => {
      this.log.info(`Socket closed for ${this.id}`);
      this._ctx.peerManager.unregisterConnection(this.id);
    });

    this.socket.on("end", () => {
      this.log.trace(`Peer finished writing: ${this.id}`);
    });

    this.socket.on("error", async (err) => {
      this.log.error({ err }, `Socket error for ${this.id}`);
      await this._ctx.peerManager.reportConnectionFailure(this.id);
      this.onHandleError(new ProtocolError(ErrorCode.INTERNAL_ERROR, "Connection error occurred."));
      this.log.trace(`Connection error for ${this.id}: ${err.message}`);
      this.socket.destroy();
    });

    this.socket.on("timeout", async () => {
      this.log.warn(`Connection timed out for ${this.id} due to inactivity.`);
      await this._ctx.peerManager.reportConnectionFailure(this.id);
      this.onHandleError(
        new ProtocolError(ErrorCode.INTERNAL_ERROR, "Connection timed out due to inactivity."),
      );
      this.socket.destroy();
    });

    this.socket.on("finish", () => {
      this.log.debug(`Write side drained for ${this.id}`);
    });
  }

  private sendInitialMessages(): void {
    this.send({
      type: MessageType.HELLO,
      version: "0.10.0",
      agent,
    });

    this.send({
      type: MessageType.GET_PEERS,
    });
    this.log.trace(
      `Outbound connections: ${this._ctx.peerManager.outboundConnectionCount}, Inbound connections: ${this._ctx.peerManager.inboundConnectionCount}`,
    );
    if (this._ctx.peerManager.shouldRequestMempoolAndChaintip()) {
      this.log.trace(
        `Requesting chain tip and mempool from peers (outbound connections: ${this._ctx.peerManager.outboundConnectionCount}, inbound connections: ${this._ctx.peerManager.inboundConnectionCount})`,
      );
      this._ctx.peerManager.broadcast({
        type: MessageType.GET_CHAIN_TIP,
      });

      this._ctx.peerManager.broadcast({
        type: MessageType.GET_MEMPOOL,
      });
    }
  }
  private onHandleError(error: Error): void {
    try {
      let isInvalidHandshakeOrFormat = false;
      if (error instanceof ProtocolError) {
        if (error.name === ErrorCode.INVALID_HANDSHAKE || error.name === ErrorCode.INVALID_FORMAT) {
          isInvalidHandshakeOrFormat = true;
        }
        if (error.name === ErrorCode.UNFINDABLE_OBJECT) {
          this.log.trace(
            `sending protocol error for ${this.id}: ${error.name} - ${error.description}`,
          );
        } else {
          this.log.trace(
            `sending protocol error for ${this.id}: ${error.name} - ${error.description}`,
          );
        }
        this.send(error);
      } else if (error instanceof MultiProtocolError) {
        for (const err of error.errors) {
          if (err.name === ErrorCode.INVALID_HANDSHAKE || err.name === ErrorCode.INVALID_FORMAT) {
            isInvalidHandshakeOrFormat = true;
          }
          this.log.error(`sending protocol error for ${this.id}: ${err.name} - ${err.description}`);
          this.send(err);
        }
      } else {
        this.log.error({ err: error }, `Unexpected error for ${this.id}`);
        this.send(
          new ProtocolError(
            ErrorCode.INTERNAL_ERROR,
            "An unexpected error occurred while processing the message.",
          ),
        );
      }
      if (isInvalidHandshakeOrFormat) {
        this.close();
      }
    } catch (err) {
      this.log.trace(`Failed to send error to ${this.id}: socket gone`);
    }
  }

  private async handleData(chunk: string): Promise<void> {
    this.buffer += chunk;
    const messages = this.buffer.split(SEPARATOR);
    this.buffer = messages.pop() || "";

    for (const rawMessage of messages) {
      if (!rawMessage.trim()) {
        continue;
      }
      //Dont await processing of messages, to prevent blocking the socket's data event loop.
      this.processMessage(rawMessage);
    }
  }

  private async processMessage(rawMessage: string): Promise<void> {
    try {
      const now = Date.now();
      if (now - this.msgWindowStart > MESSAGE_RATE_WINDOW_MS) {
        this.msgCount = 0;
        this.msgWindowStart = now;
      }
      this.msgCount++;
      if (this.msgCount > MESSAGE_RATE_LIMIT_PER_SEC) {
        void this._ctx.peerManager.reportInvalidPeerMessage(
          this.id,
          `Rate limit exceeded (${this.msgCount} messages in ${MESSAGE_RATE_WINDOW_MS}ms)`,
        );
        return;
      }

      const message = await parseMessage(rawMessage, this._ctx);
      if (!message) {
        return;
      }

      if (!checkHandshake(message, this.state)) {
        return;
      }
      this._ctx.peerManager.onSuccessfulHandshake(this.id);
      await this._ctx.dispatcher.dispatch(message, this);
    } catch (error) {
      this.onHandleError(error as Error);
    }
  }
}
