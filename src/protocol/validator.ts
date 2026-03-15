import canonicalize from "canonicalize";
import * as ed from "@noble/ed25519";
import {
  MessageType,
  ErrorCode,
  ObjectType,
  GENESIS_BLOCK_ID,
  BLOCK_REWARD,
} from "@/protocol/types";
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
  BlockMessage,
  RegularTxAmounts,
  RegularTxValidationResult,
} from "@/protocol/types";
import { parsePeerAddress } from "@/shared/utils";

export function isCoinbaseCandidate(tx: TransactionMessage): boolean {
  return tx.height !== undefined;
}

export function validateGenesisBlock(
  block: BlockMessage,
  ctx: ConnectedPeerContext,
): boolean {
  if (ctx.objectManager.id(block) !== GENESIS_BLOCK_ID) {
    throw new ProtocolError(
      ErrorCode.INVALID_GENESIS,
      `Genesis block has invalid ID ${ctx.objectManager.id(block)}`,
    );
  }
  return true;
}

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
    uniqueInputTxIds.map((txid) => ctx.objectManager.get(txid)),
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

export function verifyLawOfConservationForCoinbaseTx(
  coinbaseTx: TransactionMessage,
  txs: RegularTxValidationResult[],
  _ctx: ConnectedPeerContext,
): boolean {
  const totalFees = txs.reduce((sum, tx) => sum + tx.fee, 0);
  const coinbaseOutputValue = coinbaseTx.outputs.reduce(
    (sum, output) => sum + output.value,
    0,
  );
  const maxAllowedValue = BLOCK_REWARD + totalFees;
  if (coinbaseOutputValue > maxAllowedValue) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_COINBASE,
      `Coinbase output value ${coinbaseOutputValue} exceeds allowed value ${maxAllowedValue}`,
    );
  }
  return true;
}

export function getTxAmounts(
  resolvedInputs: ResolvedInput[],
  newOutputs: OutputTransactionMessage[],
): RegularTxAmounts {
  const totalInputValue = resolvedInputs.reduce(
    (sum, input) => sum + input.resolvedOutput.value,
    0,
  );
  const totalOutputValue = newOutputs.reduce(
    (sum, output) => sum + output.value,
    0,
  );
  return {
    inputValue: totalInputValue,
    outputValue: totalOutputValue,
    fee: totalInputValue - totalOutputValue,
  };
}

export function verifyLawOfConservationForRegularTx(
  txAmounts: RegularTxAmounts,
): boolean {
  const isConserved = txAmounts.inputValue >= txAmounts.outputValue;
  if (!isConserved) {
    throw new ProtocolError(
      ErrorCode.INVALID_TX_CONSERVATION,
      `Output value ${txAmounts.outputValue} exceeds input value ${txAmounts.inputValue}`,
    );
  }
  return isConserved;
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

export async function validateRegularTx(
  tx: TransactionMessage,
  ctx: ConnectedPeerContext,
): Promise<RegularTxValidationResult> {
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
  const resolvedInputs = await validateOutpoints(tx.inputs, ctx);
  await verifySignatures(tx, resolvedInputs);
  const txAmounts = getTxAmounts(resolvedInputs, tx.outputs);
  verifyLawOfConservationForRegularTx(txAmounts);
  checkDuplicateInputs(tx.inputs);
  return {
    resolvedInputs,
    ...txAmounts,
  };
}

export function checkPOW(
  block: BlockMessage,
  ctx: ConnectedPeerContext,
): boolean {
  if (ctx.objectManager.id(block).toLowerCase() >= block.T.toLowerCase()) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_POW,
      `Block ${ctx.objectManager.id(block)} does not satisfy proof-of-work requirement (ID is greater than target)`,
    );
  }
  return true;
}

export function checkForCoinbaseTxsInBlock(
  block: BlockMessage,
  blockTxs: TransactionMessage[],
  ctx: ConnectedPeerContext,
): boolean {
  const coinbaseTxs = blockTxs.filter(isCoinbaseCandidate);
  if (coinbaseTxs.length > 1) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_COINBASE,
      `Block contains more than one coinbase transaction (found ${coinbaseTxs.length})`,
    );
  }
  if (coinbaseTxs.length === 1) {
    const coinbaseTx = coinbaseTxs[0];
    if (ctx.objectManager.id(coinbaseTx) !== block.txids[0]) {
      throw new ProtocolError(
        ErrorCode.INVALID_BLOCK_COINBASE,
        `Coinbase transaction ID ${ctx.objectManager.id(coinbaseTx)} does not match first txid in block ${block.txids[0]}`,
      );
    }
  }
  return true;
}

export function checkForCoinbaseSpending(
  blockTxs: TransactionMessage[],
  coinbaseTxId: string,
  _: ConnectedPeerContext,
): boolean {
  for (const tx of blockTxs) {
    if (tx.inputs) {
      for (const input of tx.inputs) {
        if (input.outpoint.txid === coinbaseTxId) {
          throw new ProtocolError(
            ErrorCode.INVALID_TX_OUTPOINT,
            `Coinbase transaction ${coinbaseTxId} cannot be spent within the same block`,
          );
        }
      }
    }
  }
  return true;
}

const checkCoinbaseFormat = (
  coinbaseTx: TransactionMessage,
  _: ConnectedPeerContext,
): boolean => {
  if (coinbaseTx.inputs !== undefined) {
    throw new ProtocolError(
      ErrorCode.INVALID_FORMAT,
      `Coinbase transaction should have no inputs`,
    );
  }

  if (coinbaseTx.outputs.length !== 1) {
    throw new ProtocolError(
      ErrorCode.INVALID_FORMAT,
      `Coinbase transaction should have exactly one output`,
    );
  }
  if (coinbaseTx.height === undefined) {
    throw new ProtocolError(
      ErrorCode.INVALID_FORMAT,
      `Coinbase transaction has invalid height ${coinbaseTx.height}`,
    );
  }
  return true;
};
export async function validateBlock(
  block: BlockMessage,
  ctx: ConnectedPeerContext,
): Promise<boolean> {
  /*
	    Check that if previd is null, then the block is the genesis block.
			Protocol specifies that the genesis block has a specific id.

			VERIFIED BY zod
			a. Check that the block contains all required fields and that they are of the format specified
			in [1]. Send back an INVALID_FORMAT error otherwise.

			VERIFIED BY zod
			b. Ensure the target is the one required, i.e.
			"00000000abc00000000000000000000000000000000000000000000000000000"
			Send back an INVALID_FORMAT error otherwise.


			VERIFIED BY checkPOW
			c. Check the proof-of-work. If not satisfied, send back an INVALID_BLOCK_POW error.

			VERIFIED BY ctx.blockManager.getBlockTransactions
			d. Check that for all the txids in the block, you have the corresponding transaction in your
			local object database. If not, then send a "getobject" message to your peers in order
			to get the transaction. If you still cannot find the transaction and none of your peers
			have found it and sent it back, send back an UNFINDABLE_OBJECT error to the peer who
			sent you the block.

      VERIFIED BY validateRegularTx after checkTxsInBlock
			e. For each transaction in the block, check that the transaction is valid, and update your
			UTXO set based on the transaction. More details on this in Section 2. If any transaction
			is invalid, the whole block will be considered invalid. Since you should not add such
			invalid transaction to your database and other peers should not send it back to you,
			send back an UNFINDABLE_OBJECT error in the case of an invalid transaction in a block.

      VERIFIED BY checkForCoinbaseTxs
			f. Check for coinbase transactions. There can be at most one coinbase transaction in a
			block. If present, then the txid of the coinbase transaction must be at index 0 in txids.
			Send back an INVALID_BLOCK_COINBASE error otherwise.

      VERIFIED BY checkForCoinbaseSpending
			g. Check for coinbase transaction spending. The coinbase transaction cannot be spent in
			another transaction in the same block (this is in order to make the law of conservation
			for the coinbase transaction easier to verify). Send back an INVALID_TX_OUTPOINT error
			otherwise.

			h. Validate the coinbase transaction if there is one.
			h.a) Check that the coinbase transaction has no inputs, exactly one output and a height.
			Check that the height and the public key are of the valid format. (We will check
			if the height is correct in the next homework when we validate chains, not now.)
			Send back an INVALID_FORMAT error otherwise.
			h.b) Verify the law of conservation for the coinbase transaction. The output of the
			coinbase transaction can be at most the sum of transaction fees in the block plus
			the block reward. In our protocol, the block reward is a constant 50 × 1012 picabu.
			The fee of a transaction is the sum of its input values minus the sum of its output
			values. Send back an INVALID_BLOCK_COINBASE error otherwise.

			i. When you receive a block object from the network, validate it. If valid, then store the
			block in your local database and gossip the block. Here, “gossip” means that you send
			an ihaveobject message with the corresponding blockid.
*/
  try {
    if (block.previd === null) {
      validateGenesisBlock(block, ctx);
    }
    checkPOW(block, ctx);
    const blockTxs = await ctx.blockManager.getBlockTransactions(block, ctx);
    checkForCoinbaseTxsInBlock(block, blockTxs, ctx);
    // We know at this point that there is at most one coinbase transaction, so we can just find it instead of filtering.
    const coinbaseTx = blockTxs.find(isCoinbaseCandidate);
    if (coinbaseTx) {
      const coinbaseTxId = ctx.objectManager.id(coinbaseTx);
      checkForCoinbaseSpending(blockTxs, coinbaseTxId, ctx);
      checkCoinbaseFormat(coinbaseTx, ctx);
    }

    const validatedTxs: RegularTxValidationResult[] = [];
    for (const tx of blockTxs) {
      try {
        if (isCoinbaseCandidate(tx)) continue;
        const result = await validateRegularTx(tx, ctx);
        validatedTxs.push(result);
      } catch (e) {
        // Although validateRegular tx throws protocoleErrors, we catch those here and re-throw as UNFINDABLE_OBJECT,
        // since if a transaction in a block is invalid, we want to consider the whole block invalid.
        throw new ProtocolError(
          ErrorCode.UNFINDABLE_OBJECT,
          `Block ${ctx.objectManager.id(block)} contains invalid transaction ${ctx.objectManager.id(tx)}: ${(e as Error).message}`,
        );
      }
    }

    //We have verified the transactions in the block, so now we can use them to verify the law of conservation for the coinbase transaction if it exists.
    if (coinbaseTx) {
      verifyLawOfConservationForCoinbaseTx(coinbaseTx!, validatedTxs, ctx);
    }
    //TODO: Implement the rest of the block validation rules (timestamp, coinbase transaction, etc.)

    return true;
  } catch (e) {
    if (e instanceof ProtocolError) {
      throw e;
    }
    throw new Error(
      `unexpected error during block validation: ${(e as Error).message}`,
    );
  }
}
export async function validateObject(
  message: ObjectMessage,
  ctx: ConnectedPeerContext,
): Promise<boolean> {
  if (message.object.type === ObjectType.BLOCK) {
    //TODO: Uncomment after PSET 2 is graded.
    // return validateBlock(message.object, ctx);
    return true;
  }
  //We don't need to check for other types, as zod covers that.
  if (isCoinbaseCandidate(message.object)) return true;
  return !!(await validateRegularTx(message.object, ctx));
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
