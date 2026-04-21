import canonicalize from "canonicalize";
import * as ed from "@noble/ed25519";
import ProtocolError from "./error";
import {
  ErrorCode,
  ObjectType,
  type Connection,
  type InputTransactionMessage,
  type OutputTransactionMessage,
  type RegularTxAmounts,
  type ResolvedInput,
  type TransactionMessage,
  type TxValidationResult,
} from "./types";

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

export function verifyLawOfConservationForRegularTx(txAmounts: RegularTxAmounts): boolean {
  const isConserved = txAmounts.inputValue >= txAmounts.outputValue;
  if (!isConserved) {
    throw new ProtocolError(
      ErrorCode.INVALID_TX_CONSERVATION,
      `Output value ${txAmounts.outputValue} exceeds input value ${txAmounts.inputValue}`,
    );
  }
  return isConserved;
}

export function validateOutpoints(
  inputs: InputTransactionMessage[],
  txCache: Map<string, TransactionMessage>,
): void {
  for (const input of inputs) {
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
  }
}

export async function resolveInputs(
  inputs: InputTransactionMessage[],
  connection: Connection,
): Promise<{
  resolvedInputs: ResolvedInput[];
  txCache: Map<string, TransactionMessage>;
}> {
  const uniqueInputTxIds = [...new Set(inputs.map((input) => input.outpoint.txid))];
  let fetchedTxs;
  try {
    fetchedTxs = await Promise.all(
      uniqueInputTxIds.map((txid) => connection.ctx.objectManager.get(txid)),
    );
  } catch {
    throw new ProtocolError(
      ErrorCode.UNKNOWN_OBJECT,
      "Cannot find one or more previous transactions",
    );
  }
  const txCache = new Map<string, TransactionMessage>();
  for (let i = 0; i < uniqueInputTxIds.length; i++) {
    const foundObj = fetchedTxs[i];
    if (foundObj && foundObj.type === ObjectType.BLOCK) {
      throw new ProtocolError(ErrorCode.UNKNOWN_OBJECT, "Requested tx is not a transaction object");
    }
    if (foundObj && foundObj.type === ObjectType.TRANSACTION) {
      txCache.set(uniqueInputTxIds[i]!, foundObj);
    }
  }

  const resolvedInputs: ResolvedInput[] = inputs.map((input) => {
    const prevTx = txCache.get(input.outpoint.txid);
    const prevOutput = prevTx?.outputs[input.outpoint.index];
    return {
      ...input,
      resolvedOutput: prevOutput!,
    };
  });

  return { resolvedInputs, txCache };
}

export function getTxAmounts(
  resolvedInputs: ResolvedInput[],
  newOutputs: OutputTransactionMessage[],
): RegularTxAmounts {
  const totalInputValue = resolvedInputs.reduce(
    (sum, input) => sum + input.resolvedOutput.value,
    0,
  );
  const totalOutputValue = newOutputs.reduce((sum, output) => sum + output.value, 0);
  return {
    inputValue: totalInputValue,
    outputValue: totalOutputValue,
    fee: totalInputValue - totalOutputValue,
  };
}

export function checkDuplicateInputs(inputs: InputTransactionMessage[]): void {
  const seen = new Set<string>();
  for (const input of inputs) {
    const key = `${input.outpoint.txid}:${input.outpoint.index}`;
    if (seen.has(key)) {
      throw new ProtocolError(
        ErrorCode.INVALID_TX_OUTPOINT,
        `Transaction contains duplicate input ${key}`,
      );
    }
    seen.add(key);
  }
}

export async function validateTx(
  tx: TransactionMessage,
  connection: Connection,
): Promise<TxValidationResult> {
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

     VERIFIED BY checkDuplicateInputs function
		 e) Check duplicate inputs ( Asked in PSET 3 )
		*/
  const { resolvedInputs, txCache } = await resolveInputs(tx.inputs, connection);
  validateOutpoints(tx.inputs, txCache);
  checkDuplicateInputs(tx.inputs);
  await verifySignatures(tx, resolvedInputs);
  const txAmounts = getTxAmounts(resolvedInputs, tx.outputs);
  verifyLawOfConservationForRegularTx(txAmounts);
  return {
    resolvedInputs,
    ...txAmounts,
  };
}
