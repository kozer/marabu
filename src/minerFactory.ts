import { Worker } from "worker_threads";
import path from "path";
import os from "os";
import {
  MINER_EVENTS,
  type ChainState,
  type HashRateReport,
  type MinerController,
} from "./protocol/types";
import { HASHRATE_REPORT_INTERVAL_MS, MINE_CPU_RATIO, MINER_TYPE } from "./shared/constants";
import type pino from "pino";

const KEYS_PATH = path.resolve("keys.json");

async function loadPk(): Promise<string | null> {
  const keysExist = await Bun.file(KEYS_PATH).exists();
  if (!keysExist) {
    console.warn("Warning: Miner keys not found. Please generate keys before mining.");
    return null;
  }
  const fileContent = await Bun.file(KEYS_PATH).text();
  try {
    const keys = JSON.parse(fileContent);
    const pk = keys.publicKey;
    if (!pk) throw new Error("Public key (pk) not found in keys.json");
    return pk;
  } catch (e) {
    console.error("Error parsing keys.json:", (e as Error).message);
    return null;
  }
}

function resolveWorkerPath(scriptName: string): string {
  return path.resolve(
    import.meta.dir,
    import.meta.dir.endsWith("dist") ? scriptName.replace(".ts", ".js") : scriptName,
  );
}

function createCpuWorkers(
  pk: string,
  hashrateSubscribers: ((payload: HashRateReport) => void)[],
  blockMinedSubscribers: ((block: any, coinbaseTx: any) => void)[],
): Worker[] {
  const totalCores = os.cpus().length;
  const threadCount = Math.max(1, Math.floor(totalCores * MINE_CPU_RATIO));
  const workerPath = resolveWorkerPath("miners/miner.ts");
  const workers: Worker[] = [];

  const latestStats = new Map<number, HashRateReport>();
  let lastAggregateReport = 0;

  for (let i = 0; i < threadCount; i++) {
    const worker = new Worker(workerPath, { workerData: { pk } });
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
      if (msg.type === MINER_EVENTS.ON_BLOCK_MINED) {
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
  return workers;
}

function createGpuWorker(
  pk: string,
  hashrateSubscribers: ((payload: HashRateReport) => void)[],
  blockMinedSubscribers: ((block: any, coinbaseTx: any) => void)[],
): Worker[] {
  const workerPath = resolveWorkerPath("miners/miner-gpu.ts");
  const worker = new Worker(workerPath, { workerData: { pk } });

  worker.on("error", (err) => {
    console.error(`GPU miner worker error:`, (err as Error).message);
  });
  worker.on("exit", (code) => {
    if (code !== 0) console.error(`GPU miner worker exited with code ${code}`);
  });
  worker.on("message", (msg: any) => {
    if (msg.type === MINER_EVENTS.HASHRATE) {
      hashrateSubscribers.forEach((cb) => cb(msg.payload));
    }
    if (msg.type === MINER_EVENTS.ON_BLOCK_MINED) {
      try {
        worker.postMessage({ type: MINER_EVENTS.STOP });
      } catch {}
      blockMinedSubscribers.forEach((cb) => cb(msg.payload.block, msg.payload.coinbaseTx));
    }
  });

  return [worker];
}

export const initMiner = async (logger: pino.Logger): Promise<MinerController | null> => {
  const pk = await loadPk();
  if (!pk) return null;

  const hashrateSubscribers: ((payload: HashRateReport) => void)[] = [];
  const blockMinedSubscribers: ((block: any, coinbaseTx: any) => void)[] = [];

  const workers =
    MINER_TYPE === "gpu"
      ? createGpuWorker(pk, hashrateSubscribers, blockMinedSubscribers)
      : createCpuWorkers(pk, hashrateSubscribers, blockMinedSubscribers);

  const minerController: MinerController = {
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
      logger.info(`Restarting mining at height ${state.height} with ${txs.length} mempool txs`);
      workers.forEach((w, i) => {
        logger.trace(
          `=================== Restarting miner worker ${i} with new template (tip: ${state.tip}, height: ${state.height}, txs: ${txs.length}) ===================`,
        );
        try {
          w.postMessage({ type: MINER_EVENTS.RESTART_MINE, data: { txs, state } });
        } catch {}
      });
    },
  };
  return minerController;
};
