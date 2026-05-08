import type { UtxoEntry } from "@/protocol/types";
import type { ObjectManagerInterface } from "./objectManager";
import type { UtxoStoreInterface } from "./UtxoStore";

export interface LedgerInterface {
  getLedger(pk: string): Promise<UtxoEntry[]>;
}

class Ledger implements LedgerInterface {
  constructor(
    private readonly objectManager: ObjectManagerInterface,
    private readonly utxoStore: UtxoStoreInterface,
  ) {}

  async getLedger(pk: string): Promise<UtxoEntry[]> {
    const chainState = await this.objectManager.getChainState();
    if (chainState.height < 0) return [];
    const utxoSet = await this.utxoStore.get(chainState.tip);
    if (!utxoSet) return [];
    return [...utxoSet.values()].filter((utxo) => utxo.output.pubkey === pk);
  }
}

export default Ledger;
