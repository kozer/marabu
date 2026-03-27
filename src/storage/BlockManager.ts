import {
  ErrorCode,
  MessageType,
  ObjectType,
  type BlockMessage,
  type Connection,
  type ObjectMessage,
  type TransactionMessage,
  type UtxoSnapshot,
  type ValidatedBlock,
} from "@/protocol/types";
import type { ObjectManagerInterface } from "./objectManager";
import type UtxoStore from "./UtxoStore";
import ProtocolError from "@/protocol/error";
import type { PeerManager } from "@/peers/peerManager";
import type pino from "pino";

export interface BlockManagerInterface {
  getUtxoSet(blockId: string | null): Promise<UtxoSnapshot | null>;
  getBlock(blockId: string): Promise<BlockMessage | null>;
  getBlockTransactions(block: BlockMessage): Promise<TransactionMessage[]>;
  storeValidatedBlock(result: ValidatedBlock): Promise<void>;
  close(): Promise<void>;
}

class BlockManager implements BlockManagerInterface {
  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly utxoStore: UtxoStore,
    private readonly peerManager: PeerManager,
    private readonly logger: pino.Logger,
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
  ): Promise<TransactionMessage[]> {
    try {
      const resolvedTxs = await Promise.all(
        block.txids.map((txid) =>
          this.objectManager.findObject(txid, (id) =>
            this.peerManager.broadcast({
              type: MessageType.GET_OBJECT,
              objectid: id,
            }),
          ),
        ),
      );
      return resolvedTxs.map((obj) => {
        if (obj.type !== ObjectType.TRANSACTION) {
          // Should this happen?
          this.logger.error(
            `Expected transaction object but found object of type ${obj.type}`,
          );
          throw new Error("Expected transaction object but found block object");
        }
        return obj as TransactionMessage;
      });
    } catch (e) {
      //If we cant find a tx we should throw an UNKNOWN_OBJECT per PSET 2.
      throw new ProtocolError(
        ErrorCode.UNKNOWN_OBJECT,
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
  async close(): Promise<void> {
    await this.objectManager.close();
    await this.utxoStore.close();
  }
}
export default BlockManager;
