import {
  ErrorCode,
  MessageType,
  ObjectType,
  type BlockMessage,
  type ChainState,
  type ObjectData,
  type TransactionMessage,
  type TxEnriched,
  type UtxoSnapshot,
  type ValidateResult,
} from "@/protocol/types";
import type { ObjectManagerInterface } from "./objectManager";
import type UtxoStore from "./UtxoStore";
import ProtocolError, { MultiProtocolError } from "@/protocol/error";
import type { PeerManager } from "@/peers/peerManager";
import type pino from "pino";
import {
  applyTransactionToUtxoSet,
  checkCoinbaseFormat,
  checkForCoinbaseTxsInBlock,
  checkPOW,
  isCoinbaseCandidate,
  validateBlockTimestamp,
  validateGenesisBlock,
  validateHeightOfCoinbaseTx,
  verifyLawOfConservationForCoinbaseTx,
  verifyNoCoinbaseSpendingInBlock,
} from "@/protocol/block.validator";
import type { TransactionManager } from "./TransactionManager";
import { FIND_TIMEOUT_MS } from "@/shared/constants";

export interface BlockManagerInterface {
  getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null>;
  getBlockTransactions(block: BlockMessage): Promise<TransactionMessage[]>;
  storeValidatedBlock(blockId: string, block: ObjectData, result: ValidateResult): Promise<void>;
  handleIncoming(block: BlockMessage): Promise<ValidateResult | void>;
  validateBlock(blockId: string, block: BlockMessage): Promise<ValidateResult | null>;
  getBlockHeight(blockId?: string): Promise<number>;
  init(genBlock?: any, genesisId?: string): Promise<void>;
  getTip(): string;
  close(): Promise<void>;
}

class BlockManager implements BlockManagerInterface {
  private chainState: ChainState = { tip: "", height: -1 };
  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly utxoStore: UtxoStore,
    private readonly peerManager: PeerManager,
    private readonly transactionManager: TransactionManager,
    private readonly logger: pino.Logger,
  ) {}

  getTip(): string {
    return this.chainState.tip;
  }

  async init(genBlock?: any, genesisId?: string): Promise<void> {
    this.chainState = await this.objectManager.getChainState();

    if (this.chainState.height > 0) {
      this.logger.info(
        `Resumed chain at height ${this.chainState.height} (Tip: ${this.chainState.tip})`,
      );
    } else if (genBlock && genesisId) {
      this.logger.info("Fresh database detected. Seeding provided Genesis...");
      await this.seedGenesis(genBlock, genesisId);
    }
    if (this.chainState.height !== -1) {
      const tipBlock = (await this.objectManager.get(this.chainState.tip)) as BlockMessage;
      this.logger.info(
        `Initializing mempool with UTXO set and transactions from current tip block ${this.chainState.tip}...`,
      );
      await this.transactionManager.initializeMempool(
        await this.getUtxoSet(this.chainState.tip),
        await this.getBlockTransactions(tipBlock),
      );
    }
  }

  async getBlockHeight(blockId?: string): Promise<number> {
    if (blockId) {
      return (await this.objectManager.getBlockHeight(blockId)) ?? -1;
    }
    return this.chainState.height;
  }

  async handleIncoming(blockOrBlockId: BlockMessage | string): Promise<ValidateResult | void> {
    if (typeof blockOrBlockId === "string") {
      blockOrBlockId = await this.findBlock(blockOrBlockId);
    }
    const blockId = this.objectManager.id(blockOrBlockId);
    if (await this.objectManager.exists(blockId)) {
      this.logger.trace(`Already have block ${blockId}, skipping`);
      this.peerManager.broadcast({
        type: MessageType.IHAVEOBJECT,
        objectid: blockId,
      });
      return;
    }
    try {
      const result = await this.validateBlock(blockId, blockOrBlockId);
      await this.storeValidatedBlock(blockId, blockOrBlockId, result);
      this.peerManager.broadcast({
        type: MessageType.IHAVEOBJECT,
        objectid: blockId,
      });
      return result;
    } catch (e) {
      this.logger.error(`Validation failed for block ${blockId} : ${(e as Error).message}`);
      this.objectManager.rejectPending(blockId, e as Error);
      throw e;
    }
  }

  async getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null> {
    if (blockId === null) {
      // This  is genesis, and the block after that is empty
      return this.utxoStore.empty();
    }
    return new Map((await this.utxoStore.get(blockId)) ?? []);
  }

  private async findBlock(id: string, dependantId?: string): Promise<BlockMessage> {
    try {
      this.logger.info(`Finding block ${id} from peers...,dependant on ${dependantId}`);
      const result = await this.objectManager.findObject(
        { id, dependantId },
        (id) => {
          this.logger.info(`Broadcasting getobject for block ${id} to find block from peers...`);
          this.peerManager.broadcast({
            type: MessageType.GET_OBJECT,
            objectid: id,
          });
        },
        FIND_TIMEOUT_MS,
      );
      this.logger.info(`findBlock: result for block ${id} is ${result ? "found" : "not found"}`);
      if (result && result.type === ObjectType.BLOCK) {
        //This should always be a block if we got a result, but we check just in case.
        this.logger.info(`Block ${id} downloaded successfully`);
        return result as BlockMessage;
      } else {
        throw new Error(`Object ${id} found but is not a block (type: ${result?.type})`);
      }
    } catch (err) {
      const errors: ProtocolError[] = [];
      if (err instanceof ProtocolError) {
        errors.push(err);
      }
      if (err instanceof MultiProtocolError) {
        errors.push(...err.errors);
      }
      errors.push(new ProtocolError(ErrorCode.UNFINDABLE_OBJECT, `Block ${id} not found.`));
      throw new MultiProtocolError(errors);
    }
  }

  async getBlockTransactions(block: BlockMessage): Promise<TransactionMessage[]> {
    const results = await Promise.allSettled(
      block.txids.map((txid) =>
        this.objectManager.findObject(
          {
            id: txid,
          },
          (id) =>
            this.peerManager.broadcast({
              type: MessageType.GET_OBJECT,
              objectid: id,
            }),
          FIND_TIMEOUT_MS,
        ),
      ),
    );
    const firstError = results.find((result) => result.status === "rejected");
    if (firstError) {
      throw new ProtocolError(
        ErrorCode.UNKNOWN_OBJECT,
        `Failed to find transaction in block: ${(firstError as PromiseRejectedResult).reason}`,
      );
    }
    const blockTxs = results.map((r) => (r as PromiseFulfilledResult<ObjectData>).value);
    return blockTxs.map((obj) => {
      if (obj.type !== ObjectType.TRANSACTION) {
        // Should this happen?
        this.logger.error(`Expected transaction object but found object of type ${obj.type}`);
        throw new ProtocolError(
          ErrorCode.UNKNOWN_OBJECT,
          `Expected transaction object but found object of type ${obj.type}`,
        );
      }
      return obj as TransactionMessage;
    });
  }
  async storeValidatedBlock(
    blockId: string,
    block: BlockMessage,
    result: ValidateResult,
  ): Promise<void> {
    this.logger.info(
      result,
      `Storing validated block ${blockId} at height ${result.height} with UTXO set ${result.utxoSet ? "present" : "not present"}`,
    );
    this.logger.info(
      `Current chain state before storing block: height ${this.chainState.height}, tip ${this.chainState.tip}`,
    );
    const oldTip = this.chainState.tip;
    const oldHeight = this.chainState.height;

    await this.utxoStore.put(blockId, result.utxoSet);
    await this.objectManager.put(block, result.height);

    if (result.height > oldHeight) {
      this.logger.info(`TRIGGERING REORG: New height ${result.height} > ${oldHeight}`);
      await this.reorgToNewChain(blockId, block, result, oldTip, oldHeight);
    }
  }

  async reorgToNewChain(
    blockId: string,
    block: BlockMessage,
    result: ValidateResult,
    oldTip: string,
    oldHeight: number,
  ): Promise<void> {
    await this.objectManager.putChainState(blockId, result.height);
    if (block.previd === oldTip || oldHeight === -1 || block.previd === null) {
      // This means the new block extends our current chain, or we are at genesis, so we don't need to find common accestor.
      await this.transactionManager.reconcileMempool(result.utxoSet, []);
    } else {
      // This means we were on a fork, but the new block does not extend our current chain, so we need to reorg to the new fork.
      let oldRunningTip = oldTip;
      let currentOldHeight = oldHeight;

      let newRunningTip = blockId;
      let currentNewHeight = result.height;

      let currentNewBlock = block; // The block passed into the function
      let currentOldBlock = null;
      const abandonedTxs = [];
      this.logger.error(
        `Reorging to new chain. Old tip: ${oldTip} at height ${oldHeight}, new tip: ${blockId} at height ${result.height}`,
      );

      // 1. Go back from the new tip to old tip till we have the same height for both chains.
      // 2. Loop back both chains together till we find the common ancestor
      // 3. Along the way, we collect all transactions from the blocks in the old chain that are not in the new chain to be removed from mempool.
      while (oldRunningTip !== newRunningTip) {
        if (currentNewHeight > currentOldHeight) {
          newRunningTip = currentNewBlock.previd!;
          // Fetch the prev block in the new chain till we end up to same height as old chain
          currentNewBlock = (await this.objectManager.get(newRunningTip)) as BlockMessage;
          currentNewHeight--;
          this.logger.info(
            `Stepping back on new chain to height ${currentNewHeight} (Block: ${newRunningTip})`,
          );
          continue;
        }

        currentOldBlock = (await this.objectManager.get(oldRunningTip)) as BlockMessage;
        this.logger.info(
          `Stepping back on old chain to height ${currentOldHeight} (Block: ${oldRunningTip})`,
        );

        abandonedTxs.push(...(await this.getBlockTransactions(currentOldBlock)));
        this.logger.info(
          `Collected transactions from old block ${oldRunningTip} to be removed from mempool if we reorg to new chain. Number of transactions: ${abandonedTxs.length}`,
        );

        if (currentOldBlock.previd === currentNewBlock.previd) {
          // We have found the common ancestor. We stop.
          this.logger.info(
            `Common ancestor found at block ${currentOldBlock.previd} at height ${currentOldHeight - 1}`,
          );
          break;
        }

        oldRunningTip = currentOldBlock.previd!;
        newRunningTip = currentNewBlock.previd!;
        this.logger.info(
          `Stepping back on both chains. Old chain at height ${currentOldHeight - 1} (Block: ${oldRunningTip}), new chain at height ${currentNewHeight - 1} (Block: ${newRunningTip})`,
        );
        currentNewBlock = (await this.objectManager.get(newRunningTip)) as BlockMessage;
        this.logger.info(
          `Fetched new block ${newRunningTip} at height ${currentNewHeight - 1} during reorg`,
        );
      }
      // We want to remove transactions from the common ancestor to the old tip, so we reverse the order of the collected transactions to be removed from mempool.
      abandonedTxs.reverse();
      await this.transactionManager.reconcileMempool(result.utxoSet, abandonedTxs);
    }
    this.logger.info(`Chain updated to height ${result.height} (Tip: ${blockId})`);
    this.chainState = {
      tip: blockId,
      height: result.height,
    };
  }

  private async seedGenesis(genBlock: any, genesisId: string): Promise<void> {
    const currentState = await this.objectManager.getChainState();
    if (currentState.height >= 0) {
      this.chainState = currentState;
      this.logger.info(
        `Node started at height ${this.chainState.height} (Tip: ${this.chainState.tip})`,
      );
      return;
    }

    this.logger.info("Seeding Genesis block...");

    const genesisResult: ValidateResult = {
      utxoSet: this.utxoStore.empty(),
      height: 0,
    };

    await this.storeValidatedBlock(genesisId, genBlock, genesisResult);
  }

  async close(): Promise<void> {
    await this.objectManager.close();
    await this.utxoStore.close();
  }

  public async validateBlock(blockId: string, block: BlockMessage): Promise<ValidateResult> {
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

			VERIFIED BY this.getBlockTransactions
			d. Check that for all the txids in the block, you have the corresponding transaction in your
			local object database. If not, then send a "getobject" message to your peers in order
			to get the transaction. If you still cannot find the transaction and none of your peers
			have found it and sent it back, send back an UNFINDABLE_OBJECT error to the peer who
			sent you the block.

      VERIFIED BY resolvedInputs + calculateFees  + ensureInputsPresentInUtxo + applyTransactionToUtxoSet
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
    this.logger.info(`Validating block ${this.objectManager.id(block)}...`);
    const errors: ProtocolError[] = [];
    try {
      checkPOW(block, this.objectManager);
      if (block.previd === null) {
        validateGenesisBlock(block, this.objectManager);
        const genesisResult: ValidateResult = {
          utxoSet: this.utxoStore.empty(),
          height: 0,
        };
        return genesisResult;
      }
      let parent: BlockMessage | null = null;
      try {
        parent = (await this.objectManager.get(block.previd!)) as BlockMessage;
      } catch {}

      if (!parent) {
        parent = await this.findBlock(block.previd, blockId);
      }

      let parentHeight = await this.objectManager.getBlockHeight(block.previd);
      let parentUtxoSet = await this.getUtxoSet(block.previd);
      this.logger.info(
        `Parent block ${block.previd} found at height ${parentHeight}, UTXO set ${parentUtxoSet ? "found" : "not found"}`,
      );
      if (parentHeight === null || parentUtxoSet === null) {
        //This should not happen because we should have the UTXO set for any block in our database.
        throw new ProtocolError(
          ErrorCode.UNFINDABLE_OBJECT,
          `UTXO set or height not found for parent block ${block.previd}`,
        );
      }

      validateBlockTimestamp(block.created, parent.created);

      let blockTxs: TransactionMessage[];
      try {
        blockTxs = await this.getBlockTransactions(block);
        this.logger.info(
          `All transactions for block ${this.objectManager.id(block)} found successfully. Number of transactions: ${blockTxs.length}`,
        );
      } catch (e) {
        if (e instanceof ProtocolError) {
          errors.push(e);

          errors.push(
            new ProtocolError(
              ErrorCode.UNFINDABLE_OBJECT,
              "Block validation failed due to missing dependencies",
            ),
          );

          // Throw the whole collection!
          throw new MultiProtocolError(errors);
        }
        throw e;
      }

      this.logger.info(
        `Validating block ${this.objectManager.id(block)} with ${blockTxs.length} transactions. Parent height: ${parentHeight}, Parent UTXO set: ${
          parentUtxoSet ? "found" : "not found"
        }`,
      );
      checkForCoinbaseTxsInBlock(block, blockTxs, this.objectManager);
      // We know at this point that there is at most one coinbase transaction, so we can just find it instead of filtering.
      const coinbaseTx = blockTxs.find(isCoinbaseCandidate);
      if (coinbaseTx) {
        const coinbaseTxId = this.objectManager.id(coinbaseTx);
        verifyNoCoinbaseSpendingInBlock(blockTxs, coinbaseTxId);
        checkCoinbaseFormat(coinbaseTx);
      }

      this.logger.info(
        `Applying transactions to UTXO set for block ${this.objectManager.id(block)}. Number of transactions: ${blockTxs.length}`,
      );

      const validatedTxs: TxEnriched[] = [];
      for (const tx of blockTxs) {
        if (isCoinbaseCandidate(tx)) {
          // We have already validated the coinbase transaction separately, so we can skip it here.
          continue;
        }
        // Transactions are already validated standalone before being stored in the DB.
        // We only need to resolve inputs for UTXO checks and fee computation.
        validatedTxs.push(await this.transactionManager.resolveTxDetails(tx));
      }
      //We have verified the transactions in the block, so now we can use them to verify the law of conservation for the coinbase transaction if it exists.
      if (coinbaseTx) {
        validateHeightOfCoinbaseTx(coinbaseTx, parentHeight! + 1);
        verifyLawOfConservationForCoinbaseTx(coinbaseTx!, validatedTxs);
      }

      for (const tx of blockTxs) {
        applyTransactionToUtxoSet(tx, parentUtxoSet, this.objectManager);
      }

      this.logger.info(
        `Block ${this.objectManager.id(block)} validated successfully. Returning new UTXO set and height.`,
      );
      return {
        utxoSet: parentUtxoSet,
        height: parentHeight! + 1,
      };
    } catch (e) {
      if (e instanceof MultiProtocolError || e instanceof ProtocolError) {
        throw e;
      }
      throw new Error(`unexpected error during block validation: ${(e as Error).message}`);
    }
  }
}
export default BlockManager;
