import { parentPort, MessagePort, workerData } from "worker_threads";
import { performance } from "node:perf_hooks";
import crypto from "crypto";
import {
  TARGET,
  MINER_EVENTS,
  type WorkerMessage,
  ObjectType,
  type ChainState,
  BLOCK_REWARD,
} from "./protocol/types";
import {
  agent,
  ENABLE_MINER_PROFILING,
  HASHRATE_REPORT_INTERVAL_MS,
  MINE_YIELD,
} from "./shared/constants";
import { hashObject } from "./shared/utils";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import logger from "./shared/logger";

if (!parentPort) {
  throw new Error("This script must run as a worker thread.");
}
const { pk } = workerData;
const port: MessagePort = parentPort;

let isRunning = false;

const NONCE_WIDTH = 64;
const NONCE_PLACEHOLDER = "0".repeat(NONCE_WIDTH);

function buildTemplate(
  tip: string,
  txids: string[],
): { buf: Buffer; nonceOffset: number; created: number } {
  const created = Math.floor(Date.now() / 1000);
  const block = {
    type: ObjectType.BLOCK,
    T: TARGET,
    created,
    miner: agent,
    nonce: NONCE_PLACEHOLDER,
    previd: tip,
    txids,
  };
  const canonical = canonicalize(block)!;
  const buf = Buffer.from(canonical, "utf8");
  const nonceOffset = canonical.indexOf(NONCE_PLACEHOLDER);
  return { buf, nonceOffset, created };
}

async function PoW({ txs, state }: { txs: string[]; state: ChainState }) {
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
  let hashes = 0;
  let lastReport = performance.now();
  const { buf, nonceOffset, created } = buildTemplate(state.tip, txids);

  while (isRunning) {
    // Yield to event loop every MINE_YIELD_EVERY_MS milliseconds.
    if (nonce % BigInt(MINE_YIELD) === 0n) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const nonceHex = nonce.toString(16).padStart(NONCE_WIDTH, "0");
    buf.write(nonceHex, nonceOffset, "utf8");

    const hash = bytesToHex(blake2s(buf));
    if (ENABLE_MINER_PROFILING) {
      hashes++;
      const now = performance.now();
      const elapsed = now - lastReport;
      if (elapsed >= HASHRATE_REPORT_INTERVAL_MS) {
        const hashrate = hashes / (elapsed / 1000);
        port.postMessage({
          type: MINER_EVENTS.HASHRATE,
          payload: { hashrate, height },
        });
        hashes = 0;
        lastReport = performance.now();
      }
    }
    if (hash < TARGET) {
      const block = {
        type: ObjectType.BLOCK,
        T: TARGET,
        created,
        miner: agent,
        nonce: nonceHex,
        previd: state.tip,
        txids,
      };
      logger.error(
        `====================== Mined block ${height} | nonce: ${nonceHex.slice(0, 16)}... | hash: ${hash} ======================`,
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
