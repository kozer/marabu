import canonicalize from "canonicalize";
import * as ed from "@noble/ed25519";
import { MessageType, ErrorCode, ObjectType } from "@/protocol/types";
import ProtocolError from "@/protocol/error";
import type {
  ConnectedPeerContext,
  InputTransactionMessage,
  OutputTransactionMessage,
  PeersMessage,
  ResolvedInput,
  TransactionMessage,
  ValidMessage,
  ObjectMessage,
} from "@/protocol/types";
import { parsePeerAddress } from "@/shared/utils";

export function validatePeers(
  message: PeersMessage,
  _ctx: ConnectedPeerContext,
): boolean {
  for (const peer of message.peers) {
    if (!parsePeerAddress(peer)) {
      throw new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        "Received message with invalid format",
      );
    }
  }
  return true;
}

export async function validateOutpoints(
  inputs: InputTransactionMessage[],
  ctx: ConnectedPeerContext,
): Promise<ResolvedInput[]> {
  const uniqueInputTxIds = [
    ...new Set(inputs!.map((input) => input.outpoint.txid)),
  ];
  const fetchedTxs = await Promise.all(
    uniqueInputTxIds.map((txid) => ctx.mapper.get(txid)),
  );
  const txCache = uniqueInputTxIds.reduce((txMap, txid, index) => {
    const foundObj = fetchedTxs[index];

    if (foundObj && foundObj.object.type === ObjectType.TRANSACTION) {
      txMap.set(txid, foundObj.object);
    }

    return txMap;
  }, new Map<string, TransactionMessage>());

  const resolvedOutputs: ResolvedInput[] = [];
  for (const input of inputs!) {
    const prevTx = txCache.get(input.outpoint.txid);

    if (!prevTx) {
      throw new ProtocolError(
        ErrorCode.UNKNOWN_OBJECT,
        `Cannot find previous transaction ${input.outpoint.txid}`,
      );
    }
    if (input.outpoint.index >= prevTx.outputs.length) {
      throw new ProtocolError(
        ErrorCode.INVALID_TX_OUTPOINT,
        `Index ${input.outpoint.index} is out of bounds (tx has only ${prevTx.outputs.length} outputs)`,
      );
    }

    const prevOutput = prevTx.outputs[input.outpoint.index];
    // This should always be defined, but we check here for ts.
    if (prevOutput) {
      resolvedOutputs.push({
        ...input,
        resolvedOutput: prevOutput,
      });
    }
  }
  if (inputs.length !== resolvedOutputs.length) {
    ctx.logger.warn(
      `Resolved only ${resolvedOutputs.length} out of ${inputs.length} inputs. This should never happen.`,
    );
  }
  return resolvedOutputs;
}

export async function verifySignatures(
  tx: TransactionMessage,
  resolvedInputs: ResolvedInput[],
): Promise<boolean> {
  const txCopy = {
    ...tx,
    inputs: tx.inputs!.map((input) => ({
      ...input,
      sig: null,
    })),
  };
  const message = canonicalize(txCopy);
  if (!message) {
    // This it should never happen, but we check here for ts.
    throw new ProtocolError(
      ErrorCode.INVALID_FORMAT,
      `Failed to canonicalize transaction for signature verification`,
    );
  }
  const messageBytes = new Uint8Array(Buffer.from(message, "utf-8"));
  for (const input of resolvedInputs) {
    const pubkey = input.resolvedOutput.pubkey;
    const sig = input.sig;
    if (!sig) {
      throw new ProtocolError(
        ErrorCode.INVALID_TX_SIGNATURE,
        `Missing signature for input index ${input.outpoint.index}`,
      );
    }
    try {
      const sigBytes = new Uint8Array(Buffer.from(sig, "hex"));
      const pubkeyBytes = new Uint8Array(Buffer.from(pubkey, "hex"));
      const isValid = await ed.verifyAsync(sigBytes, messageBytes, pubkeyBytes);
      if (!isValid) {
        throw new ProtocolError(
          ErrorCode.INVALID_TX_SIGNATURE,
          `Invalid signature at input ${input.outpoint.index}`,
        );
      }
    } catch (e) {
      throw new ProtocolError(
        ErrorCode.INVALID_TX_SIGNATURE,
        `Invalid signature for input index ${input.outpoint.index}: ${(e as Error).message}`,
      );
    }
  }
  return true;
}

export function verifyLawOfConservation(
  resolvedInputs: ResolvedInput[],
  newOutputs: OutputTransactionMessage[],
): boolean {
  const totalInputValue = resolvedInputs.reduce(
    (sum, input) => sum + input.resolvedOutput.value,
    0,
  );
  const totalOutputValue = newOutputs.reduce(
    (sum, output) => sum + output.value,
    0,
  );
  const isConserved = totalInputValue >= totalOutputValue;
  if (!isConserved) {
    throw new ProtocolError(
      ErrorCode.INVALID_TX_CONSERVATION,
      `Output value ${totalOutputValue} exceeds input value ${totalInputValue}`,
    );
  }
  return isConserved;
}

export async function validateTransaction(
  tx: TransactionMessage,
  ctx: ConnectedPeerContext,
): Promise<boolean> {
  const isCoinbase = tx.height !== undefined && tx.inputs === undefined;
  if (!isCoinbase) {
    if (!tx.inputs || tx.inputs.length === 0) {
      throw new ProtocolError(
        ErrorCode.INVALID_FORMAT,
        `Received transaction message with missing inputs`,
      );
    }
    /*
		 VERIFIED BY validateOutpoints function
     a) For each input, validate the outpoint. For this, ensure that a valid transaction with
     the given txid exists in your object database and that the given index is less than
     the number of outputs in the outpoint transaction.

     VERIFIED BY verifySignatures function
     b) For each input, verify the signature. Our protocol uses ed25519 signatures. A
     Typescript package for ed25519 is available [4]. Note that signatures and public
     keys are given as hex strings in our protocol but the package uses Uint8 arrays, so
     you would have to convert between the two.

     VERIFIED BY ZOD
     c) Outputs contain a public key and a value. The public keys must be in the correct
     format and the value must be a non-negative integer.

     VERIFIED BY verifyLawOfConservation function
     d) Transactions must respect the law of conservation, i.e. the sum of all input values
     is at least the sum of output values.
		*/
    const resolvedInputs = await validateOutpoints(tx.inputs, ctx);
    return (
      (await verifySignatures(tx, resolvedInputs)) &&
      verifyLawOfConservation(resolvedInputs, tx.outputs)
    );
  }
  // Coinbase transaction is always valid for now.
  return true;
}

export async function validateObject(
  message: ObjectMessage,
  ctx: ConnectedPeerContext,
): Promise<boolean> {
  if (message.object.type === ObjectType.BLOCK) {
    return true;
  }
  //We don't need to check for other types, as zod covers that.
  return validateTransaction(message.object, ctx);
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
  [MessageType.OBJECT]: validateObject as unknown as GenericValidator,
};

export const validateMessage = async (
  message: ValidMessage,
  ctx: ConnectedPeerContext,
): Promise<void> => {
  const validator = validatorHandlers[message.type];
  if (validator) {
    return await validator(message, ctx);
  }
};
