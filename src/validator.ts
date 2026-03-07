import { MessageType } from "./constants";
import ProtocolError, { ErrorCode } from "./error";
import type {
  ConnectedPeerContext,
  PeersMessage,
  TransactionMessage,
  ValidMessage,
} from "./types";
import { parseHost } from "./utils";

export function validateHost(host: string): boolean {
  const { port } = parseHost(host) || {};
  if (!port) {
    return false;
  }
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function validatePeers(
  message: PeersMessage,
  _ctx: ConnectedPeerContext,
): boolean {
  for (const peer of message.peers) {
    if (!validateHost(peer)) {
      throw new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        `Received message with invalid format`,
      );
    }
  }
  return true;
}

export function validateOutpoints(
  _inputs: TransactionMessage["inputs"],
): boolean {
  return true;
}

export function verifySignatures(
  _inputs: TransactionMessage["inputs"],
): boolean {
  return true;
}

export function verifyPublicKeys(
  _outputs: TransactionMessage["outputs"],
): boolean {
  return true;
}

export function verifyLawOfConservation(
  _inputs: TransactionMessage["inputs"],
  _outputs: TransactionMessage["outputs"],
): boolean {
  return true;
}
export function validateTransaction(
  tx: TransactionMessage,
  _ctx: ConnectedPeerContext,
): boolean {
  const isCoinbase = tx.height !== undefined && tx.inputs === undefined;
  if (!isCoinbase) {
    if (tx.inputs === undefined) {
      throw new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        `Received transaction message with missing inputs`,
      );
    }
    return (
      validateOutpoints(tx.inputs) &&
      verifySignatures(tx.inputs) &&
      verifyPublicKeys(tx.outputs) &&
      verifyLawOfConservation(tx.inputs, tx.outputs)
    );
  }
  // Coinbase transaction is always valid for now.
  return true;
}

type GenericValidator = (
  message: ValidMessage,
  ctx: ConnectedPeerContext,
) => Promise<void>;

export const validatorHandlers: Partial<
  Record<
    MessageType,
    (message: ValidMessage, ctx: ConnectedPeerContext) => Promise<void>
  >
> = {
  [MessageType.PEERS]: validatePeers as unknown as GenericValidator,
  [MessageType.TRANSACTION]: validateTransaction as unknown as GenericValidator,
};

export const validateMessage = (
  message: ValidMessage,
  ctx: ConnectedPeerContext,
) => {
  const validator = validatorHandlers[message.type];
  if (validator) {
    validator(message, ctx);
  }
};
