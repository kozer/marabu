import { Worker } from "worker_threads";
import path from "path";
import os from "os";
import {
  MINER_EVENTS,
  type ChainState,
  type HashRateReport,
  type MinerController,
} from "./protocol/types";
import {
  ENABLE_MINER_PROFILING,
  HASHRATE_REPORT_INTERVAL_MS,
  MINE_CPU_RATIO,
} from "./shared/constants";

const workerPath = path.resolve(
  import.meta.dir,
  import.meta.dir.endsWith("dist") ? "miner.js" : "miner.ts",
);
const totalCores = os.cpus().length;
const threadCount = Math.max(1, Math.floor(totalCores * MINE_CPU_RATIO));
const workers: Worker[] = [];

let KEYS_PATH = path.resolve("keys.json");

export const initMiner = async () => {
  let hashrateSubscribers: ((payload: HashRateReport) => void)[] = [];
  let blockMinedSubscribers: ((block: any, coinbaseTx: any) => void)[] = [];

  const latestStats = new Map<number, HashRateReport>();
  let lastAggregateReport = 0;
  const keysExist = await Bun.file(KEYS_PATH).exists();
  if (!keysExist) {
    console.warn("Warning: Miner keys not found. Please generate keys before mining.");
    return null;
  }
  const fileContent = await Bun.file(KEYS_PATH).text();
  let pk: string;
  try {
    const keys = JSON.parse(fileContent);
    pk = keys.publicKey;
    if (!pk) {
      throw new Error("Public key (pk) not found in keys.json");
    }
  } catch (e) {
    console.error("Error parsing keys.json:", (e as Error).message);
    return null;
  }
  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(workerPath, {
      workerData: { pk },
    });
    worker.on("error", (err) => {
      console.error(`Miner worker ${i} error:`, (err as Error).message);
    });
    worker.on("exit", (code) => {
      if (code !== 0) console.error(`Miner worker ${i} exited with code ${code}`);
    });
    worker.on("message", (msg: any) => {
      if (msg.type === MINER_EVENTS.HASHRATE) {
        latestStats.set(i, msg.payload);
        const now = Date.now();
        if (now - lastAggregateReport >= HASHRATE_REPORT_INTERVAL_MS) {
          lastAggregateReport = now;
          const combinedHashrate = Array.from(latestStats.values()).reduce(
            (acc, stat) => acc + stat.hashrate,
            0,
          );
          hashrateSubscribers.forEach((cb) =>
            cb({ hashrate: combinedHashrate, height: msg.payload.height }),
          );
        }
      }
      if (msg.type === MINER_EVENTS.ON_BLOCK_MINED && ENABLE_MINER_PROFILING) {
        workers.forEach((other) => {
          try {
            other.postMessage({ type: MINER_EVENTS.STOP });
          } catch {}
        });
        blockMinedSubscribers.forEach((cb) => cb(msg.payload.block, msg.payload.coinbaseTx));
      }
    });
    workers.push(worker);
  }

  const minerController = {
    stop: () => {
      workers.forEach((w) => {
        try {
          w.postMessage({ type: MINER_EVENTS.STOP });
        } catch {}
      });
    },
    onHashrateUpdate: (callback: (payload: HashRateReport) => void) => {
      hashrateSubscribers.push(callback);
    },
    onBlockMined: (callback: (block: any, coinbaseTx: any) => void) => {
      blockMinedSubscribers.push(callback);
    },
    restartMine: (txs: string[], state: ChainState) => {
      workers.forEach((w) => {
        try {
          w.postMessage({ type: MINER_EVENTS.RESTART_MINE, data: { txs, state } });
        } catch {}
      });
    },
  } as MinerController;
  return minerController;
};
