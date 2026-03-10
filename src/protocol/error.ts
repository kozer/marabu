import canonicalize from "canonicalize";
import { SEPARATOR } from "@/shared/constants";
import { ErrorCode, MessageType } from "@/protocol/types";

class ProtocolError extends Error {
  // Hardcoded to "error" so the peer knows this is an error message
  readonly type = MessageType.ERROR;
  override readonly name: ErrorCode;
  readonly description: string;

  constructor(name: ErrorCode, description: string) {
    super(description);

    this.name = name;
    this.description = description;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ProtocolError);
    }
  }

  toMessage(): string {
    return (
      canonicalize({
        type: this.type,
        name: this.name,
        description: this.description,
      }) + SEPARATOR
    );
  }
}

export default ProtocolError;
