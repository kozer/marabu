import {
  ErrorCode,
  MessageType,
  ObjectType,
  type BlockMessage,
  type Connection,
  type ObjectData,
  type ObjectMessage,
  type TransactionMessage,
  type TxValidationResult,
  type UtxoSnapshot,
  type ValidatedBlock,
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
  validateGenesisBlock,
  verifyLawOfConservationForCoinbaseTx,
  verifyNoCoinbaseSpendingInBlock,
} from "@/protocol/block.validator";
import type { TransactionManager } from "./TransactionManager";

export interface BlockManagerInterface {
  getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null>;
  findBlock(blockId: string): Promise<BlockMessage | null>;
  getTip(): Promise<string | null>;
  getBlockTransactions(block: BlockMessage): Promise<TransactionMessage[]>;
  storeValidatedBlock(result: ValidatedBlock): Promise<void>;
  handleIncoming(block: BlockMessage, id: string): Promise<ValidatedBlock | void>;
  validateBlock(block: BlockMessage): Promise<ValidatedBlock | null>;
  close(): Promise<void>;
}

class BlockManager implements BlockManagerInterface {
  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly utxoStore: UtxoStore,
    private readonly peerManager: PeerManager,
    private readonly transactionManager: TransactionManager,
    private readonly logger: pino.Logger,
  ) {}

  async handleIncoming(block: BlockMessage, connectionId: string): Promise<ValidatedBlock | void> {
    const result = await this.validateBlock(block);
    await this.storeValidatedBlock(result);
    this.peerManager.broadcast(
      {
        type: MessageType.IHAVEOBJECT,
        objectid: this.objectManager.id(block),
      },
      connectionId,
    );
    return result;
    // Persist the block and its UTXO snapshot.
  }
  async getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null> {
    if (blockId === null) {
      // This  is genesis, and the block after that is empty
      return this.utxoStore.empty();
    }
    return this.utxoStore.get(blockId);
  }

  async getTip(): Promise<string> {
    try {
      return await this.objectManager.getTip();
    } catch (e) {
      this.logger.error(`Error getting tip: ${(e as Error).message}`);
      return "";
    }
  }
  async findBlock(blockId: string): Promise<BlockMessage | null> {
    try {
      const result = await this.objectManager.findObject(
        blockId,
        (id) =>
          this.peerManager.broadcast({
            type: MessageType.GET_OBJECT,
            objectid: id,
          }),
        15_000,
      );
      this.logger.error(
        `findBlock: result for block ${blockId} is ${result ? "found" : "not found"}`,
      );
      if (result && result.type === ObjectType.BLOCK) {
        this.logger.error(`Block ${blockId} downloaded successfully`);
        return result as BlockMessage;
      }
      return null;
    } catch (err) {
      this.logger.error(`Error finding block ${blockId}: ${(err as Error).message}`);
      return null;
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
      throw new ProtocolError(ErrorCode.UNKNOWN_OBJECT, "Object is not a transaction");
    }
    const blockTxs = results.map((r) => (r as PromiseFulfilledResult<ObjectData>).value);
    return blockTxs.map((obj) => {
      if (obj.type !== ObjectType.TRANSACTION) {
        // Should this happen?
        this.logger.error(`Expected transaction object but found object of type ${obj.type}`);
        throw new ProtocolError(ErrorCode.UNKNOWN_OBJECT, `Failed to find transaction in block`);
      }
      return obj as TransactionMessage;
    });
  }
  async storeValidatedBlock(result: ValidatedBlock): Promise<void> {
    await this.objectManager.put(result.block);
    await this.utxoStore.put(result.blockId, result.utxoSetAfterTxApply);
    await this.objectManager.updateTip(result.blockId);
  }

  async seedGenesis(genBlock: any, genesisId: any): Promise<void> {
    const genesisBlock: ObjectMessage = {
      type: MessageType.OBJECT,
      object: genBlock,
    };
    if (!(await this.objectManager.exists(this.objectManager.id(genesisBlock.object)))) {
      await this.objectManager.put(genesisBlock.object);
      await this.objectManager.updateTip(this.objectManager.id(genesisBlock.object));
    }
    if (!(await this.utxoStore.has(genesisId))) {
      await this.utxoStore.put(genesisId, this.utxoStore.empty());
    }
  }
  async close(): Promise<void> {
    await this.objectManager.close();
    await this.utxoStore.close();
  }

  public async validateBlock(block: BlockMessage): Promise<ValidatedBlock> {
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
      if (block.previd === null) {
        validateGenesisBlock(block, this.objectManager);
      }
      checkPOW(block, this.objectManager);
      let parentUtxo = await this.getUtxoSet(block.previd);
      if (!parentUtxo) {
        try {
          const result = await this.findBlock(block.previd!);
          if (!result) {
            throw new Error(`Parent block ${block.previd} not found`);
          }
          parentUtxo = await this.getUtxoSet(block.previd);
        } catch (e) {
          throw new ProtocolError(
            ErrorCode.UNFINDABLE_OBJECT,
            `Parent block ${block.previd} not found for block ${this.objectManager.id(block)}`,
          );
        }
      }
      // We create a copy
      const utxoSet = new Map(parentUtxo);

      let blockTxs: TransactionMessage[];
      try {
        blockTxs = await this.getBlockTransactions(block);
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
        if (isCoinbaseCandidate(tx)) continue;
        // Transactions are already validated standalone before being stored in the DB.
        // We only need to resolve inputs for UTXO checks and fee computation.
        const result = await this.transactionManager.resolveTxDetails(tx);
        ensureInputsPresentInUtxo(tx.inputs!, utxoSet);
        applyTransactionToUtxoSet(tx, utxoSet, this.objectManager);
        validatedTxs.push(result);
      }

      //We have verified the transactions in the block, so now we can use them to verify the law of conservation for the coinbase transaction if it exists.
      if (coinbaseTx) {
        verifyLawOfConservationForCoinbaseTx(coinbaseTx!, validatedTxs);
        applyTransactionToUtxoSet(coinbaseTx, utxoSet, this.objectManager);
      }

      return {
        utxoSetAfterTxApply: utxoSet,
        blockId: this.objectManager.id(block),
        block,
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
