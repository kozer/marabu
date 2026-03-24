import {
  ErrorCode,
  MessageType,
  ObjectType,
  type BlockMessage,
  type ConnectedPeerContext,
  type ObjectMessage,
  type TransactionMessage,
  type UtxoSnapshot,
  type ValidatedBlock,
} from "@/protocol/types";
import type { ObjectManagerInterface } from "./objectManager";
import type UtxoStore from "./UtxoStore";
import ProtocolError from "@/protocol/error";

export interface BlockManagerInterface {
  getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null>;
  getBlock(blockId: string): Promise<BlockMessage | null>;
  getBlockTransactions(
    block: BlockMessage,
    ctx: ConnectedPeerContext,
  ): Promise<TransactionMessage[]>;
  storeValidatedBlock(result: ValidatedBlock): Promise<void>;
}

class BlockManager implements BlockManagerInterface {
  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly utxoStore: UtxoStore,
  ) {}
  async getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null> {
    if (blockId === null) {
      // This  is genesis, and the block after that is empty
      return this.utxoStore.empty();
    }
    return this.utxoStore.get(blockId);
  }
  async getBlock(blockId: string): Promise<BlockMessage | null> {
    try {
      const result = await this.objectManager.get(blockId);
      if (result && result.type === ObjectType.BLOCK) {
        return result as BlockMessage;
      }
      return null;
    } catch (err) {
      return null;
    }
  }
  async getBlockTransactions(
    block: BlockMessage,
    ctx: ConnectedPeerContext,
  ): Promise<TransactionMessage[]> {
    try {
      const resolvedTxs = await Promise.all(
        block.txids.map((txid) =>
          ctx.objectManager.findObject(txid, (id) =>
            ctx.peerManager.broadcast(
              {
                type: MessageType.GET_OBJECT,
                objectid: id,
              },
              ctx.id,
            ),
          ),
        ),
      );
      return resolvedTxs.map((obj) => {
        if (obj.type !== ObjectType.TRANSACTION) {
          // Should this happen?
          throw new Error(
            `Object with ID ${ctx.objectManager.id(obj)} is not a transaction`,
          );
        }
        return obj as TransactionMessage;
      });
    } catch (e) {
      throw new ProtocolError(
        ErrorCode.UNFINDABLE_OBJECT,
        `Failed to find transaction in block: ${(e as Error).message}`,
      );
    }
  }
  async storeValidatedBlock(result: ValidatedBlock): Promise<void> {
    await this.objectManager.put(result.block);
    await this.utxoStore.put(result.blockId, result.utxoSetAfterTxApply);
  }

  async seedGenesis(genBlock: any, genesisId: any): Promise<void> {
    const genesisBlock: ObjectMessage = {
      type: MessageType.OBJECT,
      object: genBlock,
    };
    if (
      !(await this.objectManager.exists(
        this.objectManager.id(genesisBlock.object),
      ))
    ) {
      await this.objectManager.put(genesisBlock.object);
    }
    if (!(await this.utxoStore.has(genesisId))) {
      await this.utxoStore.put(genesisId, this.utxoStore.empty());
    }
  }
}
export default BlockManager;
