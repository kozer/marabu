import ProtocolError from "./error";
import { getTxAmounts, resolveInputs } from "./transaction.validator";
import {
  BLOCK_REWARD,
  ErrorCode,
  GENESIS_BLOCK_ID,
  type BlockMessage,
  type Connection,
  type InputTransactionMessage,
  type TransactionMessage,
  type TxValidationResult,
  type UtxoSnapshot,
  type ValidatedBlock,
} from "./types";

export function validateGenesisBlock(block: BlockMessage, connection: Connection): boolean {
  if (connection.ctx.objectManager.id(block) !== GENESIS_BLOCK_ID) {
    throw new ProtocolError(
      ErrorCode.INVALID_GENESIS,
      `Genesis block has invalid ID ${connection.ctx.objectManager.id(block)}`,
    );
  }
  return true;
}

export function checkPOW(block: BlockMessage, connection: Connection): boolean {
  if (connection.ctx.objectManager.id(block).toLowerCase() >= block.T.toLowerCase()) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_POW,
      `Block ${connection.ctx.objectManager.id(block)} does not satisfy proof-of-work requirement (ID is greater than target)`,
    );
  }
  return true;
}

export const checkCoinbaseFormat = (coinbaseTx: TransactionMessage, _: Connection): boolean => {
  if (coinbaseTx.inputs !== undefined) {
    throw new ProtocolError(ErrorCode.INVALID_FORMAT, `Coinbase transaction should have no inputs`);
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

export function verifyNoCoinbaseSpendingInBlock(
  blockTxs: TransactionMessage[],
  coinbaseTxId: string,
  _: Connection,
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

export function verifyLawOfConservationForCoinbaseTx(
  coinbaseTx: TransactionMessage,
  txs: TxValidationResult[],
  _connection: Connection,
): boolean {
  const totalFees = txs.reduce((sum, tx) => sum + tx.fee, 0);
  const coinbaseOutputValue = coinbaseTx.outputs.reduce((sum, output) => sum + output.value, 0);
  const maxAllowedValue = BLOCK_REWARD + totalFees;
  if (coinbaseOutputValue > maxAllowedValue) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_COINBASE,
      `Coinbase output value ${coinbaseOutputValue} exceeds allowed value ${maxAllowedValue}`,
    );
  }
  return true;
}

export function isCoinbaseCandidate(tx: TransactionMessage): boolean {
  return tx.height !== undefined;
}

export function ensureInputsPresentInUtxo(
  inputs: InputTransactionMessage[],
  utxoSet: UtxoSnapshot,
): void {
  for (const input of inputs) {
    const key = `${input.outpoint.txid}:${input.outpoint.index}` as const;
    if (!utxoSet.has(key)) {
      throw new ProtocolError(ErrorCode.INVALID_TX_OUTPOINT, `UTXO ${key} not found`);
    }
  }
}

export function checkForCoinbaseTxsInBlock(
  block: BlockMessage,
  blockTxs: TransactionMessage[],
  connection: Connection,
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
    if (connection.ctx.objectManager.id(coinbaseTx) !== block.txids[0]) {
      throw new ProtocolError(
        ErrorCode.INVALID_BLOCK_COINBASE,
        `Coinbase transaction ID ${connection.ctx.objectManager.id(coinbaseTx)} does not match first txid in block ${block.txids[0]}`,
      );
    }
  }
  return true;
}

export function applyTransactionToUtxoSet(
  tx: TransactionMessage,
  utxoSet: UtxoSnapshot,
  connection: Connection,
): void {
  // Remove spent outputs from UTXO set. We check for inputs (?? []) to cover coinbase txs as well.
  // Coinbase transactions have no inputs, and are not being spend by current block, so we don't need to do anything to the UTXO set for them.
  for (const input of tx.inputs ?? []) {
    const key = `${input.outpoint.txid}:${input.outpoint.index}` as const;
    utxoSet.delete(key);
  }
  const txId = connection.ctx.objectManager.id(tx);
  tx.outputs.forEach((output, index) => {
    const key = `${txId}:${index}` as const;
    utxoSet.set(key, {
      txid: txId,
      index,
      output,
    });
  });
}

export async function validateBlock(
  block: BlockMessage,
  connection: Connection,
): Promise<ValidatedBlock | null> {
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

      VERIFIED BY resolvedInputs + getTxAmounts  + ensureInputsPresentInUtxo + applyTransactionToUtxoSet
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
      validateGenesisBlock(block, connection);
    }
    checkPOW(block, connection);
    //TODO: In case of not having the parent block, db will return null, and for PSET3, we will simply ignore the block. Remove later.
    const parentUtxo = await connection.ctx.blockManager.getUtxoSet(block.previd);
    if (!parentUtxo) {
      return null;
    }
    // We create a copy
    const utxoSet = new Map(parentUtxo);

    let blockTxs: TransactionMessage[];
    try {
      blockTxs = await connection.ctx.blockManager.getBlockTransactions(block);
    } catch (e) {
      if (e instanceof ProtocolError) {
        connection.send(e);
      }
      // One of the transactions is not found. Per PSET 3, we need to send back an UNFINDABLE_OBJECT error, since a block with missing transactions is invalid.
      throw new ProtocolError(
        ErrorCode.UNFINDABLE_OBJECT,
        `Block ${connection.ctx.objectManager.id(block)} contains an unfindable transaction: ${(e as Error).message}`,
      );
    }
    checkForCoinbaseTxsInBlock(block, blockTxs, connection);
    // We know at this point that there is at most one coinbase transaction, so we can just find it instead of filtering.
    const coinbaseTx = blockTxs.find(isCoinbaseCandidate);
    if (coinbaseTx) {
      const coinbaseTxId = connection.ctx.objectManager.id(coinbaseTx);
      verifyNoCoinbaseSpendingInBlock(blockTxs, coinbaseTxId, connection);
      checkCoinbaseFormat(coinbaseTx, connection);
    }

    const validatedTxs: TxValidationResult[] = [];
    for (const tx of blockTxs) {
      if (isCoinbaseCandidate(tx)) continue;
      // Transactions are already validated standalone before being stored in the DB.
      // We only need to resolve inputs for UTXO checks and fee computation.
      const { resolvedInputs } = await resolveInputs(tx.inputs!, connection);
      const txAmounts = getTxAmounts(resolvedInputs, tx.outputs);
      ensureInputsPresentInUtxo(tx.inputs!, utxoSet);
      applyTransactionToUtxoSet(tx, utxoSet, connection);
      validatedTxs.push({ resolvedInputs, ...txAmounts });
    }

    //We have verified the transactions in the block, so now we can use them to verify the law of conservation for the coinbase transaction if it exists.
    if (coinbaseTx) {
      verifyLawOfConservationForCoinbaseTx(coinbaseTx!, validatedTxs, connection);
      applyTransactionToUtxoSet(coinbaseTx, utxoSet, connection);
    }

    return {
      utxoSetAfterTxApply: utxoSet,
      blockId: connection.ctx.objectManager.id(block),
      block,
    };
  } catch (e) {
    if (e instanceof ProtocolError) {
      throw e;
    }
    throw new Error(`unexpected error during block validation: ${(e as Error).message}`);
  }
}
