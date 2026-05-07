import { parentPort, workerData } from "worker_threads";
import { performance } from "node:perf_hooks";
import path from "path";
import crypto from "crypto";
import {
  TARGET,
  MINER_EVENTS,
  type WorkerMessage,
  ObjectType,
  type ChainState,
  BLOCK_REWARD,
} from "@/protocol/types";
import {
  ENABLE_MINER_PROFILING,
  GPU_BATCH_SIZE,
  HASHRATE_REPORT_INTERVAL_MS,
} from "@/shared/constants";
import { hashObject } from "@/shared/utils";
import { blake2s } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import logger from "@/shared/logger";
import { create, globals } from "webgpu";
import { NONCE_WIDTH, buildTemplate } from "./utils";

if (!parentPort) {
  throw new Error("This script must run as a worker thread.");
}
const { pk } = workerData;
const port = parentPort;

// Inject 'navigator.gpu' into Node.js (must happen before adapter request)
Object.assign(globalThis, globals);
(globalThis as any).navigator = { gpu: create([]) };

const shaderPath = path.join(__dirname, "shader.wgsl");

let isRunning = false;
let device: GPUDevice;

// Mirror of the GPU's thread_id_to_ascii_hex: packs u32 into 8 hex chars
// in little-endian nibble order (LSB nibble first) to match GPU output.
function packThreadIdToAsciiHexLE(id: number): string {
  let result = "";
  for (let i = 0; i < 8; i++) {
    const nibble = (id >> (i * 4)) & 0xf;
    const ascii = nibble < 10 ? 0x30 + nibble : 0x57 + nibble;
    result += String.fromCharCode(ascii);
  }
  return result;
}

// Helper to convert the Hex Target into a WGSL-compatible 8-word array
function targetToUint32Array(targetHex: string): Uint32Array {
  const padded = targetHex.padStart(64, "0");
  const arr = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    const chunk = padded.slice(i * 8, i * 8 + 8);
    arr[i] = parseInt(chunk, 16);
  }
  return arr;
}

async function PoW({ txs, state }: { txs: string[]; state: ChainState }) {
  const height = state.height + 1;

  const coinbaseTx = {
    type: ObjectType.TRANSACTION,
    outputs: [{ pubkey: pk, value: BLOCK_REWARD }],
    height,
  };
  const txids = [hashObject(coinbaseTx), ...txs];

  logger.info(
    `============================================================ Mining block ${height} | tip: ${state.tip.slice(0, 8)} | mempool: ${txs.length} txs (GPU) ==============================================================`,
  );

  const { buf, nonceOffset, block } = buildTemplate(state.tip, txids);

  // MEMORY ALIGNMENT: WGSL writes in 4-byte chunks (u32).
  // The string offset might not divide perfectly by 4.
  const alignedNonceByteOffset = Math.ceil(nonceOffset / 4) * 4;
  const u32NonceIndex = alignedNonceByteOffset / 4;

  const paddedLength = Math.ceil(buf.byteLength / 4) * 4;
  const alignedTemplate = Buffer.alloc(paddedLength);

  // 1. Setup GPU Buffers
  const gpuTemplateBuffer = device.createBuffer({
    size: alignedTemplate.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const configBuffer = device.createBuffer({
    size: 44, // 11 words (3 config fields + 8 target words, tightly packed for storage)
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const resultBuffer = device.createBuffer({
    size: 44, // 11 words (1 atomic count + 10 winners array)
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });

  const stagingBuffer = device.createBuffer({
    size: 44,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // 2. Write static Configuration once
  const configData = new Uint32Array(11);
  configData[0] = buf.byteLength;
  configData[1] = u32NonceIndex;
  configData[2] = GPU_BATCH_SIZE;
  configData.set(targetToUint32Array(TARGET), 3);
  device.queue.writeBuffer(configBuffer, 0, configData);

  // 3. Compile Pipeline
  const shaderCode = await Bun.file(shaderPath).text();
  const shaderModule = device.createShaderModule({ code: shaderCode });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shaderModule, entryPoint: "main" },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: gpuTemplateBuffer } },
      { binding: 1, resource: { buffer: resultBuffer } },
      { binding: 2, resource: { buffer: configBuffer } },
    ],
  });

  let hashes = 0;
  let lastReport = performance.now();

  // 4. Infinite GPU mining loop
  while (isRunning) {
    // A. Generate fresh 64-character random base nonce on CPU
    const randomBaseNonce = crypto.randomBytes(32).toString("hex");
    buf.write(randomBaseNonce, nonceOffset, "utf8");
    buf.copy(alignedTemplate);

    // B. Send fresh template to GPU, zero out result counter
    device.queue.writeBuffer(gpuTemplateBuffer, 0, alignedTemplate);
    device.queue.writeBuffer(resultBuffer, 0, new Uint32Array([0]));

    // C. Dispatch compute
    const commandEncoder = device.createCommandEncoder();
    const pass = commandEncoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(GPU_BATCH_SIZE / 64));
    pass.end();

    // D. Copy results to CPU-readable memory
    commandEncoder.copyBufferToBuffer(resultBuffer, 0, stagingBuffer, 0, 44);
    device.queue.submit([commandEncoder.finish()]);

    // E. Wait for batch and inspect results
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    const resultArray = new Uint32Array(stagingBuffer.getMappedRange());
    const winnersCount = resultArray[0];

    if (winnersCount && winnersCount > 0) {
      const winningThreadId = resultArray[1]!;

      // Reconstruct the exact 8 hex chars GPU wrote (LE nibble order).
      const winningHexChars = packThreadIdToAsciiHexLE(winningThreadId);

      // Inject those 8 characters at the aligned byte offset.
      buf.write(winningHexChars, alignedNonceByteOffset, "utf8");

      const finalNonce = buf.toString("utf8", nonceOffset, nonceOffset + NONCE_WIDTH);
      const finalHash = bytesToHex(blake2s(buf));

      block.nonce = finalNonce;

      logger.error(
        `====================== Mined block ${height} (GPU) | nonce: ${finalNonce.slice(0, 16)}... | hash: ${finalHash} ======================`,
      );

      port.postMessage({
        type: MINER_EVENTS.ON_BLOCK_MINED,
        payload: { block, coinbaseTx },
      });

      stagingBuffer.unmap();
      isRunning = false;
      break;
    }

    stagingBuffer.unmap();

    if (ENABLE_MINER_PROFILING) {
      hashes += GPU_BATCH_SIZE;
      const now = performance.now();
      const elapsed = now - lastReport;
      if (elapsed >= HASHRATE_REPORT_INTERVAL_MS) {
        const hashrate = hashes / (elapsed / 1000);
        port.postMessage({
          type: MINER_EVENTS.HASHRATE,
          payload: { hashrate, height },
        });
        hashes = 0;
        lastReport = now;
      }
    }
  }
}

// Initialize GPU device once at worker startup
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  throw new Error("WebGPU Adapter not found. Cannot start GPU miner.");
}
device = await adapter.requestDevice();

port.on("message", async (message: WorkerMessage) => {
  const { data, type } = message;
  if (type === MINER_EVENTS.STOP) {
    isRunning = false;
  } else if (type === MINER_EVENTS.RESTART_MINE) {
    isRunning = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    isRunning = true;
    PoW(data).catch((err) => logger.error({ err }, "GPU PoW crashed"));
  }
});
