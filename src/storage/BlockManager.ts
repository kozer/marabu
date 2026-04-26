import {
  ErrorCode,
  MessageType,
  ObjectType,
  type BlockMessage,
  type ChainState,
  type ObjectData,
  type TransactionMessage,
  type TxValidationResult,
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
  ensureInputsPresentInUtxo,
  isCoinbaseCandidate,
  validateBlockTimestamp,
  validateGenesisBlock,
  validateHeightOfCoinbaseTx,
  verifyLawOfConservationForCoinbaseTx,
  verifyNoCoinbaseSpendingInBlock,
} from "@/protocol/block.validator";
import type { TransactionManager } from "./TransactionManager";
import { FIND_TIMEOUT_MS, isTest } from "@/shared/constants";

export interface BlockManagerInterface {
  getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null>;
  getBlockTransactions(block: BlockMessage): Promise<TransactionMessage[]>;
  storeValidatedBlock(blockId: string, block: ObjectData, result: ValidateResult): Promise<void>;
  handleIncoming(block: BlockMessage, id: string): Promise<ValidateResult | void>;
  validateBlock(block: BlockMessage): Promise<ValidateResult | null>;
  getBlockHeight(blockId?: string): Promise<number>;
  init(genBlock?: any, genesisId?: string): Promise<void>;
  getTip(): string;
  close(): Promise<void>;
}

class BlockManager implements BlockManagerInterface {
  private chainState: ChainState = { tip: "", height: -1 };
  private root: string | null = null;
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
  }

  async getBlockHeight(blockId?: string): Promise<number> {
    if (blockId) {
      return (await this.objectManager.getBlockHeight(blockId)) ?? -1;
    }
    return this.chainState.height;
  }

  async handleIncoming(
    blockOrBlockId: BlockMessage | string,
    connectionId: string,
  ): Promise<ValidateResult | void> {
    if (typeof blockOrBlockId === "string") {
      blockOrBlockId = await this.findBlock(blockOrBlockId);
    }
    const blockId = this.objectManager.id(blockOrBlockId);
    const result = await this.validateBlock(blockOrBlockId);
    await this.storeValidatedBlock(blockId, blockOrBlockId, result);
    this.peerManager.broadcast(
      {
        type: MessageType.IHAVEOBJECT,
        objectid: blockId,
      },
      connectionId,
    );
    return result;
  }

  async getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null> {
    if (blockId === null) {
      // This  is genesis, and the block after that is empty
      return this.utxoStore.empty();
    }
    return this.utxoStore.get(blockId);
  }

  private async findBlock(blockId: string): Promise<BlockMessage> {
    try {
      const result = await this.objectManager.findObject(
        blockId,
        (id) =>
          this.peerManager.broadcast({
            type: MessageType.GET_OBJECT,
            objectid: id,
          }),
        isTest ? FIND_TIMEOUT_MS : 60_000,
      );
      this.logger.info(
        `findBlock: result for block ${blockId} is ${result ? "found" : "not found"}`,
      );
      if (result && result.type === ObjectType.BLOCK) {
        //This should always be a block if we got a result, but we check just in case.
        this.logger.info(`Block ${blockId} downloaded successfully`);
        return result as BlockMessage;
      } else {
        throw new Error(`Object ${blockId} found but is not a block (type: ${result?.type})`);
      }
    } catch (err) {
      this.logger.error(`Error finding block ${blockId}: ${(err as Error).message}`);
      throw new ProtocolError(ErrorCode.UNFINDABLE_OBJECT, `Block ${blockId} not found.`);
    }
  }

  async getBlockTransactions(block: BlockMessage): Promise<TransactionMessage[]> {
    const results = await Promise.allSettled(
      block.txids.map((txid) =>
        this.objectManager.findObject(txid, (id) =>
          this.peerManager.broadcast({
            type: MessageType.GET_OBJECT,
            objectid: id,
          }),
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
    block: ObjectData,
    result: ValidateResult,
  ): Promise<void> {
    this.logger.info(
      result,
      `Storing validated block ${blockId} at height ${result.height} with UTXO set ${result.utxoSet ? "present" : "not present"}`,
    );
    this.logger.info(`Current root is ${this.root}.`);
    this.logger.info(
      `Current chain state before storing block: height ${this.chainState.height}, tip ${this.chainState.tip}`,
    );
    await this.utxoStore.put(blockId, result.utxoSet);

    if (result.height >= this.chainState.height) {
      this.logger.info(
        `New block at height ${result.height} extends current chain height ${this.chainState.height}. Updating chain state...`,
      );
      await this.objectManager.putChainState(blockId, result.height);
      //await this.reorg()

      this.chainState = {
        tip: blockId,
        height: result.height,
      };

      this.logger.info(`Chain updated to height ${result.height} (Tip: ${blockId})`);
    }
    if (result.height < this.chainState.height) {
      this.logger.warn(
        `Received block ${blockId} at height ${result.height} is behind current chain height ${this.chainState.height}. Potential fork detected.`,
      );
      //  root height
      this.logger.warn(
        `Current root is ${this.root}, which is at height ${await this.objectManager.getBlockHeight(this.root!)}`,
      );
      // this.reorg()
    }
    this.logger.info(`Putting block ${blockId} into object manager at height ${result.height}`);
    await this.objectManager.put(block, result.height);
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

  public async validateBlock(block: BlockMessage): Promise<ValidateResult> {
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
        parent = await this.findBlock(block.previd!);
      } else {
        this.root = this.objectManager.id(block);
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

      checkForCoinbaseTxsInBlock(block, blockTxs, this.objectManager);
      // We know at this point that there is at most one coinbase transaction, so we can just find it instead of filtering.
      const coinbaseTx = blockTxs.find(isCoinbaseCandidate);
      if (coinbaseTx) {
        const coinbaseTxId = this.objectManager.id(coinbaseTx);
        verifyNoCoinbaseSpendingInBlock(blockTxs, coinbaseTxId);
        checkCoinbaseFormat(coinbaseTx);
      }

      const validatedTxs: TxValidationResult[] = [];
      for (const tx of blockTxs) {
        if (isCoinbaseCandidate(tx)) {
          // We have already validated the coinbase transaction separately, so we can skip it here.
          this.logger.info(
            `Skipping coinbase transaction ${this.objectManager.id(tx)} during transaction validation loop.`,
          );
          continue;
        }
        // Transactions are already validated standalone before being stored in the DB.
        // We only need to resolve inputs for UTXO checks and fee computation.
        const result = await this.transactionManager.resolveTxDetails(tx);
        ensureInputsPresentInUtxo(tx.inputs!, parentUtxoSet);
        this.logger.info(
          `Utxo set before applying transaction ${this.objectManager.id(tx)}: ${JSON.stringify(parentUtxoSet)}`,
        );

        applyTransactionToUtxoSet(tx, parentUtxoSet, this.objectManager);
        this.logger.info(
          `Utxo set after applying transaction ${this.objectManager.id(tx)}: ${JSON.stringify(parentUtxoSet)}`,
        );
        validatedTxs.push(result);
      }

      //We have verified the transactions in the block, so now we can use them to verify the law of conservation for the coinbase transaction if it exists.
      if (coinbaseTx) {
        validateHeightOfCoinbaseTx(coinbaseTx, parentHeight! + 1);
        verifyLawOfConservationForCoinbaseTx(coinbaseTx!, validatedTxs);
        applyTransactionToUtxoSet(coinbaseTx, parentUtxoSet, this.objectManager);
      }

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
