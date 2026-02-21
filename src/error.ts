import canonicalize from "canonicalize";
import { MessageType, SEPARATOR } from "./constants";

/**
 * Protocol Error Codes for Node-to-Node Communication
 */
export enum ErrorCode {
  // An error occurred within the node while processing the message.
  INTERNAL_ERROR = "INTERNAL_ERROR",

  // The format of the received message is invalid.
  INVALID_FORMAT = "INVALID_FORMAT",

  // The object requested is unknown to that specific node.
  UNKNOWN_OBJECT = "UNKNOWN_OBJECT",

  // The object requested could not be found in the node's network.
  UNFINDABLE_OBJECT = "UNFINDABLE_OBJECT",

  // The peer sent other validly formatted messages before sending a valid hello message.
  INVALID_HANDSHAKE = "INVALID_HANDSHAKE",

  // The transaction outpoint index is too large.
  INVALID_TX_OUTPOINT = "INVALID_TX_OUTPOINT",

  // The transaction signature is invalid.
  INVALID_TX_SIGNATURE = "INVALID_TX_SIGNATURE",

  // The transaction does not satisfy the weak law of conservation.
  INVALID_TX_CONSERVATION = "INVALID_TX_CONSERVATION",

  // The block coinbase transaction is invalid.
  INVALID_BLOCK_COINBASE = "INVALID_BLOCK_COINBASE",

  // The block timestamp is invalid.
  INVALID_BLOCK_TIMESTAMP = "INVALID_BLOCK_TIMESTAMP",

  // The block proof-of-work is invalid.
  INVALID_BLOCK_POW = "INVALID_BLOCK_POW",

  // The block has a previd of null but it isn't genesis.
  INVALID_GENESIS = "INVALID_GENESIS",
}

class ProtocolError extends Error {
  // Hardcoded to "error" so the peer knows this is an error message
  readonly type = MessageType.ERROR;
  readonly code: ErrorCode;
  readonly description: string;

  constructor(code: ErrorCode, description: string) {
    super(description);

    this.code = code;
    this.description = description;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProtocolError);
    }
  }

  toMessage(): string {
    return (
      canonicalize({
        type: this.type,
        name: this.code,
        description: this.description,
      }) + SEPARATOR
    );
  }
}

export default ProtocolError;
