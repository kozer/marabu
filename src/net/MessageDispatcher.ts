import type { PeerManager } from "@/peers/peerManager";
import type { Connection, ValidMessage } from "@/protocol/types";
import type BlockManager from "@/storage/BlockManager";
import type { ObjectManagerInterface } from "@/storage/objectManager";
import type { TransactionManager } from "@/storage/TransactionManager";
import { messageHandlers } from "./messageHandlers";
import type pino from "pino";
import type Ledger from "@/storage/Ledger";

export type ManagerSet = {
  block: BlockManager;
  tx: TransactionManager;
  peer: PeerManager;
  object: ObjectManagerInterface;
  ledger: Ledger;
};

export class MessageDispatcher {
  constructor(
    private managers: {
      block: BlockManager;
      tx: TransactionManager;
      peer: PeerManager;
      object: ObjectManagerInterface;
      ledger: Ledger;
    },
    private logger: pino.Logger,
  ) {}

  async dispatch(message: ValidMessage, connection: Connection): Promise<void> {
    // Look up the legacy handler from your existing record
    const handler = messageHandlers[message.type];

    if (!handler) {
      this.logger.error(`No handler for message type: ${message.type}`);
      return;
    }

    await handler(message, connection, this.managers);
  }
}
