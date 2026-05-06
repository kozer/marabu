import type pino from "pino";
import {
  ErrorCode,
  MessageType,
  type MinerController,
  type TransactionMessage,
  type TxEnriched,
  type UtxoSnapshot,
} from "@/protocol/types";
import type { ObjectManagerInterface } from "./objectManager";
import {
  applyTransactionToUtxoSet,
  checkCoinbaseFormat,
  isCoinbaseCandidate,
} from "@/protocol/block.validator";
import {
  checkDuplicateInputs,
  calculateFees,
  resolveInputs,
  validateOutpoints,
  verifyLawOfConservationForRegularTx,
  verifySignatures,
} from "@/protocol/transaction.validator";
import ProtocolError from "@/protocol/error";
import type { PeerManager } from "@/peers/peerManager";
import { createThrottle } from "@/shared/utils";
import { THROTTLE_MINING_DELAY_MS } from "@/shared/constants";

const restartMineDebounced = createThrottle(THROTTLE_MINING_DELAY_MS);

export class TransactionManager {
  private mempoolTxs: Map<string, TransactionMessage> = new Map();
  private mempoolState: UtxoSnapshot = new Map();
  private pendingTxValidations: Map<string, Promise<void>> = new Map();
  /*Promise chain to serialize mempool updates
   * https://www.geeksforgeeks.org/javascript/how-to-execute-multiple-promises-sequentially-in-javascript/
   * */
  private mempoolLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly peerManager: PeerManager,
    private readonly logger: pino.Logger,
    private miner: MinerController | null = null,
  ) {}

  async initializeMempool(state: UtxoSnapshot | null, txs: TransactionMessage[]): Promise<void> {
    this.mempoolState = state ? new Map(state) : new Map();
    this.mempoolTxs.clear();
    for (const tx of txs) {
      this.checkAndAddToMempool(tx, this.mempoolState);
    }
    this.logger.trace(
      `Initialized mempool with transactions: ${[...this.mempoolTxs.keys()].join(", ")}, mempool state has ${this.mempoolState.size} UTXOs`,
    );
    restartMineDebounced(async () => {
      this?.miner?.restartMine(await this.getMempool(), await this.objectManager.getChainState());
    });
  }

  async handleMempoolRequest(txIds: string[]): Promise<void> {
    for (const txId of txIds) {
      if (!(await this.objectManager.exists(txId))) {
        this.peerManager.broadcast({
          type: MessageType.GET_OBJECT,
          objectid: txId,
        });
      }
    }
  }

  async getMempool(): Promise<string[]> {
    return [...this.mempoolTxs.keys()];
  }

  async close(): Promise<void> {
    await this.mempoolLock;
    const txids = [...this.mempoolTxs.keys()];
    await this.objectManager.putMeta("mempoolTxids", txids);
    this.logger.info(`Saved ${txids.length} mempool txids on close`);
  }

  async handleIncoming(tx: TransactionMessage): Promise<void> {
    if (await this.objectManager.exists(this.objectManager.id(tx))) {
      return;
    }
    let pendingValidation = this.pendingTxValidations.get(this.objectManager.id(tx));
    if (pendingValidation) {
      return pendingValidation;
    }

    const validationPromise = this.processIncomingTx(tx);
    this.pendingTxValidations.set(this.objectManager.id(tx), validationPromise);
    return validationPromise;
  }

  private async processIncomingTx(tx: TransactionMessage): Promise<void> {
    const txId = this.objectManager.id(tx);
    try {
      if (isCoinbaseCandidate(tx)) {
        // For coinbase transactions, we only do basic format checks since they are not fully valid until included in a block and validated as part of that block.
        checkCoinbaseFormat(tx);
      } else {
        await this.validateTx(tx);
      }
      await this.objectManager.put(tx);
      const resultPromise = new Promise<void>((resolve, reject) => {
        this.mempoolLock = this.mempoolLock
          .then(async () => {
            try {
              // There is a case where the incoming tx is part of a block ( older than our current height ) that we have not seen yet ( part of a fork )
              // so we might not have the inputs of the tx in our object manager yet.
              // In that case, should store the tx but the check against mempool UTXO set will fail and we will not add it to the mempool until we receive the block that contains it and apply it to the UTXO set,
              // at which point the tx will become valid and added to the mempool.
              await this.checkAndAddToMempool(tx, this.mempoolState);
              resolve();
            } catch (err) {
              this.logger.warn(`Tx ${txId} failed mempool: ${(err as Error).message}`);
              reject(err);
            }
          })
          .catch((err) => {
            this.logger.error("System lock failure", err);
          });
      });
      await resultPromise;
      this.logger.trace(`Current mempool transactions: ${[...this.mempoolTxs.keys()].join(", ")}`);
      restartMineDebounced(async () => {
        this?.miner?.restartMine(await this.getMempool(), await this.objectManager.getChainState());
      });
      this.peerManager.broadcast({
        type: MessageType.IHAVEOBJECT,
        objectid: txId,
      });
    } finally {
      this.pendingTxValidations.delete(txId);
    }
  }

  async checkAndAddToMempool(tx: TransactionMessage, mempool: UtxoSnapshot): Promise<void> {
    if (isCoinbaseCandidate(tx)) {
      return;
    }
    applyTransactionToUtxoSet(tx, mempool, this.objectManager);
    this.mempoolTxs.set(this.objectManager.id(tx), tx);
  }

  async reconcileMempool(state: UtxoSnapshot, blockTxs: TransactionMessage[]): Promise<void> {
    this.mempoolLock = this.mempoolLock.then(async () => {
      const newMempoolState = new Map(state);
      this.logger.trace(
        `Old mempool transactions: ${[...this.mempoolTxs.entries()].join(", ")}, new mempool state has ${newMempoolState.size} UTXOs`,
      );
      const txs = [];

      for (const tx of blockTxs) {
        txs.push(tx);
      }
      for (const [, tx] of this.mempoolTxs) {
        txs.push(tx);
      }
      this.mempoolTxs.clear();

      for (const tx of txs) {
        //This is copied from validateBlock function in BlockManager.
        // We need to re-validate all transactions in the mempool against the new UTXO set after a new block is added, since some transactions might have become invalid (e.g. due to double spends)
        //and we need to remove them from the mempool.
        try {
          await this.checkAndAddToMempool(tx, newMempoolState);
        } catch (err) {
          this.logger.warn(
            `Removing transaction ${this.objectManager.id(tx)} from mempool during reconciliation: ${(err as Error).message}`,
          );
        }
      }
      this.mempoolState = newMempoolState;
      restartMineDebounced(async () => {
        this?.miner?.restartMine(await this.getMempool(), await this.objectManager.getChainState());
      });
      this.logger.trace(
        `Reconciled mempool transactions: ${[...this.mempoolTxs.keys()].join(", ")}`,
      );
    });
    await this.mempoolLock;
  }

  async validateTx(tx: TransactionMessage): Promise<TxEnriched> {
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

    const txDetails = await this.resolveTxDetails(tx);

    validateOutpoints(tx.inputs!, txDetails.txCache);
    checkDuplicateInputs(tx.inputs!);

    await verifySignatures(tx, txDetails.resolvedInputs);

    verifyLawOfConservationForRegularTx(txDetails);

    return txDetails;
  }
  async resolveTxDetails(
    tx: TransactionMessage,
  ): Promise<TxEnriched & { txCache: Map<string, TransactionMessage> }> {
    const { resolvedInputs, txCache } = await resolveInputs(tx.inputs!, this.objectManager);
    const txAmounts = calculateFees(resolvedInputs, tx.outputs);

    return {
      resolvedInputs,
      txCache,
      ...txAmounts,
    };
  }
}
