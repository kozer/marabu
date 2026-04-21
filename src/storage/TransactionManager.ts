import type pino from "pino";
import {
  ErrorCode,
  MessageType,
  type Connection,
  type TransactionMessage,
  type TxValidationResult,
} from "@/protocol/types";
import type { ObjectManagerInterface } from "./objectManager";
import { checkCoinbaseFormat, isCoinbaseCandidate } from "@/protocol/block.validator";
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

export class TransactionManager {
  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly peerManager: PeerManager,
    private readonly _logger: pino.Logger,
  ) {}

  async handleIncoming(tx: TransactionMessage, connection: Connection): Promise<void> {
    if (isCoinbaseCandidate(tx)) {
      // For coinbase transactions, we only do basic format checks since they are not fully valid until included in a block and validated as part of that block.
      checkCoinbaseFormat(tx);
    } else {
      await this.validateTx(tx);
    }
    await this.objectManager.put(tx);
    this.peerManager.broadcast(
      {
        type: MessageType.IHAVEOBJECT,
        objectid: this.objectManager.id(tx),
      },
      connection.id,
    );
  }

  async validateTx(tx: TransactionMessage): Promise<TxValidationResult> {
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

    // 1. Gather the facts (The new helper we just named)
    const txDetails = await this.resolveTxDetails(tx);

    // 2. Judge the facts (Validation logic)
    // We use the resolved data to run our checks
    validateOutpoints(tx.inputs!, txDetails.txCache);
    checkDuplicateInputs(tx.inputs!);

    await verifySignatures(tx, txDetails.resolvedInputs);

    verifyLawOfConservationForRegularTx(txDetails);

    return txDetails;
  }
  async resolveTxDetails(
    tx: TransactionMessage,
  ): Promise<TxValidationResult & { txCache: Map<string, TransactionMessage> }> {
    const { resolvedInputs, txCache } = await resolveInputs(tx.inputs!, this.objectManager);
    const txAmounts = calculateFees(resolvedInputs, tx.outputs);

    return {
      resolvedInputs,
      txCache,
      ...txAmounts,
    };
  }
}
