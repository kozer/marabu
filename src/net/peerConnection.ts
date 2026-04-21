import { Socket } from "net";
import { SEPARATOR } from "@/shared/constants";
import ProtocolError from "@/protocol/error";
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
    sendMessage(this.socket, message);
  }

  private onConnect(): void {
    if (this.direction === ConnectionDirection.INBOUND) {
      this._ctx.peerManager.registerInboundConnection(this);
    }
    if (this.direction === ConnectionDirection.OUTBOUND) {
      this._ctx.peerManager.registerOutboundConnection(this);
    }

    this.sendInitialMessages();
  }

  private attachSocketHandlers(): void {
    if (this.socket.readyState === "open") {
      this.onConnect();
    } else {
      this.socket.on("connect", () => this.onConnect());
    }
    this.socket.on("data", (data) => {
      void this.handleData(data.toString());
    });

    this.socket.on("end", () => {
      this.log.info("Closing connection with the client");
      this._ctx.peerManager.unregisterConnection(this.id);
    });

    this.socket.on("error", async (err) => {
      await this._ctx.peerManager.reportConnectionFailure(this.id);

      this._ctx.peerManager.unregisterConnection(this.id);
      this.socket.destroy();
      this.log.warn(`Connection error for ${this.id}: ${err.message}`);
    });

    this.socket.on("timeout", async () => {
      this.log.warn(`Connection timeout for ${this.id}`);
      await this._ctx.peerManager.reportConnectionFailure(this.id);

      this._ctx.peerManager.unregisterConnection(this.id);
      this.socket.destroy();
    });

    this.socket.on("finish", () => {
      this._ctx.peerManager.unregisterConnection(this.id);
      this.log.debug(`Socket finished for ${this.id}`);
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
  private onHandleError(error: Error): void {
    this.log.error({ err: error }, "Message handler failed");
    if (error instanceof ProtocolError) {
      this.send(error);
    } else {
      this.send(
        new ProtocolError(
          ErrorCode.INTERNAL_ERROR,
          "An unexpected error occurred while processing the message.",
        ),
      );
    }
    this.socket.end();
    return;
  }

  private async handleData(chunk: string): Promise<void> {
    this.buffer += chunk;
    const messages = this.buffer.split(SEPARATOR);
    this.buffer = messages.pop() || "";

    for (const rawMessage of messages) {
      if (!rawMessage.trim()) {
        continue;
      }

      let message: ValidMessage | null = null;
      try {
        message = await parseMessage(rawMessage, this._ctx);
        if (!message) {
          return;
        }

        if (!checkHandshake(message, this.state)) {
          return;
        }
        await this._ctx.dispatcher.dispatch(message, this);
        this.log.info({ type: message.type }, `[${this._ctx.id}]: Received message`);
      } catch (error) {
        this.onHandleError(error as Error);
      }
    }
  }
}
