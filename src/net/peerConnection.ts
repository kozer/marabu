import { Socket } from "net";
import { CHAIN_TIP_NUMBER_OF_CONNECTED_PEERS, SEPARATOR } from "@/shared/constants";
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
      this.onHandleError(new ProtocolError(ErrorCode.INTERNAL_ERROR, "Connection error occurred."));
      this.log.trace(`Connection error for ${this.id}: ${err.message}`);
    });

    this.socket.on("timeout", async () => {
      await this._ctx.peerManager.reportConnectionFailure(this.id);

      this._ctx.peerManager.unregisterConnection(this.id);
      this.onHandleError(
        new ProtocolError(ErrorCode.INTERNAL_ERROR, "Connection timed out due to inactivity."),
      );
    });

    this.socket.on("finish", () => {
      this._ctx.peerManager.unregisterConnection(this.id);
      this.onHandleError(
        new ProtocolError(ErrorCode.INTERNAL_ERROR, "Connection finished unexpectedly."),
      );
      this.log.debug(`Socket finished for ${this.id}`);
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
    if (this._ctx.peerManager.totalConnections % CHAIN_TIP_NUMBER_OF_CONNECTED_PEERS === 0) {
      this.log.error(
        `Connected to ${CHAIN_TIP_NUMBER_OF_CONNECTED_PEERS} peers, sending GET_CHAIN_TIP message.`,
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
    let isInvalidHandshakeOrFormat = false;
    if (error instanceof ProtocolError) {
      this.log.trace(`Protocol error for ${this.id}: ${error.name} - ${error.description}`);
      if (error.name === ErrorCode.INVALID_HANDSHAKE || error.name === ErrorCode.INVALID_FORMAT) {
        isInvalidHandshakeOrFormat = true;
      }
      this.send(error);
    } else if (error instanceof MultiProtocolError) {
      for (const err of error.errors) {
        this.log.error(`Protocol error for ${this.id}: ${err.name} - ${err.description}`);
        if (err.name === ErrorCode.INVALID_HANDSHAKE || err.name === ErrorCode.INVALID_FORMAT) {
          isInvalidHandshakeOrFormat = true;
        }
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
      this.socket.end();
    }
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
      //Dont await processing of messages, to prevent blocking the socket's data event loop.
      this.processMessage(rawMessage);
    }
  }

  private async processMessage(rawMessage: string): Promise<void> {
    try {
      const message = await parseMessage(rawMessage, this._ctx);
      if (!message) {
        return;
      }

      if (!checkHandshake(message, this.state)) {
        return;
      }
      await this._ctx.dispatcher.dispatch(message, this);
    } catch (error) {
      this.onHandleError(error as Error);
    }
  }
}
