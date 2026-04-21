import type pino from "pino";
import { type TransactionMessage } from "@/protocol/types";
import type { ObjectManagerInterface } from "./objectManager";

export class TransactionManager {
  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Main entry point for validating a transaction against a specific UTXO state.
   * This is used both for Mempool admission and Block validation.
   */
  async validate(tx: TransactionMessage): Promise<any> {
    this.logger.debug(`Validating transaction: ${this.objectManager.id(tx)}`);
  }
}
