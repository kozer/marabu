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
  getParentUtxo(prevBlockId: string): Promise<UtxoSnapshot | null>;
  getBlock(blockId: string): Promise<BlockMessage | null>;
  getBlockTransactions(
    block: BlockMessage,
    ctx: ConnectedPeerContext,
  ): Promise<TransactionMessage[]>;
  storeAccepted(result: ValidatedBlock): Promise<void>;
}

class BlockManager implements BlockManagerInterface {
  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly utxoStore: UtxoStore,
  ) {}
  async getParentUtxo(prevBlockId: string): Promise<UtxoSnapshot | null> {
    if (prevBlockId === null) {
      // This  is genesis, and the block after that is empty
      return this.utxoStore.empty();
    }
    return this.utxoStore.getAfterBlock(prevBlockId);
  }
  async getBlock(blockId: string): Promise<BlockMessage | null> {
    try {
      const result = await this.objectManager.get(blockId);
      if (result.object && result.object.type === ObjectType.BLOCK) {
        return result.object as BlockMessage;
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
        if (obj.object.type !== ObjectType.TRANSACTION) {
          // Should this happen?
          throw new Error(
            `Object with ID ${ctx.objectManager.id(obj.object)} is not a transaction`,
          );
        }
        return obj.object as TransactionMessage;
      });
    } catch (e) {
      throw new ProtocolError(
        ErrorCode.UNFINDABLE_OBJECT,
        `Failed to find transaction in block: ${(e as Error).message}`,
      );
    }
  }
  async storeAccepted(result: ValidatedBlock): Promise<void> {
    await this.objectManager.put({
      type: MessageType.OBJECT,
      object: result.block,
    } as ObjectMessage);
    await this.utxoStore.putAfterBlock(result.blockId, result.utxoAfterBlock);
  }
}
export default BlockManager;
