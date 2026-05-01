import { parentPort, MessagePort, workerData } from "worker_threads";
import crypto from "crypto";
import {
  TARGET,
  MINER_EVENTS,
  type WorkerMessage,
  ObjectType,
  type ChainState,
  BLOCK_REWARD,
} from "./protocol/types";
import { agent } from "./shared/constants";
import { hashObject } from "./shared/utils";
import logger from "./shared/logger";

if (!parentPort) {
  throw new Error("This script must run as a worker thread.");
}
const { pk } = workerData;
const port: MessagePort = parentPort;

let isRunning = false;

async function PoW({ txs, state }: { txs: string[]; state: ChainState }) {
  const created = Math.floor(Date.now() / 1000);
  const height = state.height + 1;

  const coinbaseTx = {
    type: ObjectType.TRANSACTION,
    outputs: [{ pubkey: pk, value: BLOCK_REWARD }],
    height,
  };
  const txids = [hashObject(coinbaseTx), ...txs];

  logger.error(
    `============================================================ Mining block ${height} | tip: ${state.tip.slice(0, 8)} | mempool: ${txs.length} txs ==============================================================`,
  );

  let nonce = BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);

  while (isRunning) {
    if (nonce % 10000n === 0n) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const block = {
      type: ObjectType.BLOCK,
      T: TARGET,
      created: nonce % 10000n === 0n ? Math.floor(Date.now() / 1000) : created,
      miner: agent,
      nonce: nonce.toString(16),
      previd: state.tip,
      txids,
    };

    const hash = hashObject(block);
    if (hash < TARGET) {
      logger.error(
        `====================== Mined block ${height} | nonce: ${nonce.toString(16).slice(0, 16)}... | hash: ${hash} ======================`,
      );
      port.postMessage({
        type: MINER_EVENTS.ON_BLOCK_MINED,
        payload: { block, coinbaseTx },
      });
      isRunning = false;
      break;
    }
    nonce += 1n;
  }
}

port.on("message", async (message: WorkerMessage) => {
  const { data, type } = message;
  if (type === MINER_EVENTS.STOP) {
    isRunning = false;
  } else if (type === MINER_EVENTS.RESTART_MINE) {
    isRunning = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    isRunning = true;
    PoW(data).catch((err) => logger.error({ err }, "PoW crashed"));
  }
});
