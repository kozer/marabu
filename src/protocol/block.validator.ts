import type { ObjectManagerInterface } from "@/storage/objectManager";
import ProtocolError from "./error";
import {
  BLOCK_REWARD,
  ErrorCode,
  GENESIS_BLOCK_ID,
  type BlockMessage,
  type InputTransactionMessage,
  type TransactionMessage,
  type TxValidationResult,
  type UtxoSnapshot,
} from "./types";

export function validateGenesisBlock(
  block: BlockMessage,
  objectManager: ObjectManagerInterface,
): boolean {
  if (objectManager.id(block) !== GENESIS_BLOCK_ID) {
    throw new ProtocolError(
      ErrorCode.INVALID_GENESIS,
      `Genesis block has invalid ID ${objectManager.id(block)}`,
    );
  }
  return true;
}

export function checkPOW(block: BlockMessage, objectManager: ObjectManagerInterface): boolean {
  if (objectManager.id(block).toLowerCase() >= block.T.toLowerCase()) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_POW,
      `Block ${objectManager.id(block)} does not satisfy proof-of-work requirement (ID is greater than target)`,
    );
  }
  return true;
}

export const checkCoinbaseFormat = (coinbaseTx: TransactionMessage): boolean => {
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

export function validateHeightOfCoinbaseTx(
  coinbaseTx: TransactionMessage,
  blockHeight: number,
): boolean {
  if (coinbaseTx.height !== blockHeight) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_COINBASE,
      `Coinbase transaction height ${coinbaseTx.height} does not match block height ${blockHeight}`,
    );
  }
  return true;
}

export function validateCoinbaseTxIsFirstInBlock(
  coinbaseTx: TransactionMessage,
  blockTxs: TransactionMessage[],
  objectManager: ObjectManagerInterface,
): boolean {
  if (objectManager.id(coinbaseTx) !== objectManager.id(blockTxs[0])) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_COINBASE,
      `Coinbase transaction ID ${objectManager.id(coinbaseTx)} does not match first transaction ID in block ${objectManager.id(blockTxs[0])}`,
    );
  }
  return true;
}

export function verifyLawOfConservationForCoinbaseTx(
  coinbaseTx: TransactionMessage,
  txs: TxValidationResult[],
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

export function validateBlockTimestamp(blockCreated: number, parentCreated: number): boolean {
  if (blockCreated <= parentCreated || blockCreated > Math.floor(Date.now() / 1000)) {
    throw new ProtocolError(
      ErrorCode.INVALID_BLOCK_TIMESTAMP,
      `Block timestamp ${blockCreated} is not greater than parent timestamp ${parentCreated}`,
    );
  }
  return true;
}

export function checkForCoinbaseTxsInBlock(
  block: BlockMessage,
  blockTxs: TransactionMessage[],
  objectManager: ObjectManagerInterface,
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
    if (objectManager.id(coinbaseTx) !== block.txids[0]) {
      throw new ProtocolError(
        ErrorCode.INVALID_BLOCK_COINBASE,
        `Coinbase transaction ID ${objectManager.id(coinbaseTx)} does not match first txid in block ${block.txids[0]}`,
      );
    }
  }
  return true;
}

export function applyTransactionToUtxoSet(
  tx: TransactionMessage,
  utxoSet: UtxoSnapshot,
  objectManager: ObjectManagerInterface,
): void {
  // Remove spent outputs from UTXO set. We check for inputs (?? []) to cover coinbase txs as well.
  // Coinbase transactions have no inputs, and are not being spend by current block, so we don't need to do anything to the UTXO set for them.
  for (const input of tx.inputs ?? []) {
    const key = `${input.outpoint.txid}:${input.outpoint.index}` as const;
    utxoSet.delete(key);
  }
  const txId = objectManager.id(tx);
  tx.outputs.forEach((output, index) => {
    const key = `${txId}:${index}` as const;
    utxoSet.set(key, {
      txid: txId,
      index,
      output,
    });
  });
}
