import { createServer, Socket } from "net";
import { Level } from "level";
import logger from "@/shared/logger";
import { SERVER_PORT, PEERS_FILE, DEFAULT_DB_PATH, MINER_ENABLED } from "@/shared/constants";
import { handleInboundConnection, handleOutboundConnection } from "@/net/connection";
import { PeerManager } from "@/peers/peerManager";
import { FilePeerStore } from "@/peers/peerStore";
import ObjectManager from "./storage/objectManager";
import type {
  BlockMessage,
  ConnectedPeerContext,
  TransactionMessage,
  UtxoRow,
} from "./protocol/types";
import UtxoStore from "./storage/UtxoStore";
import BlockManager from "./storage/BlockManager";
import { GENESIS_BLOCK, GENESIS_BLOCK_ID } from "./protocol/types";
import { MessageDispatcher } from "./net/MessageDispatcher";
import { TransactionManager } from "./storage/TransactionManager";
import { initMiner } from "./minerController";

export type NodeOptions = {
  dbPath?: string;
  peersFile?: string;
  seed?: boolean;
  isolated?: boolean;
  port?: number;
};

export type NodeHandle = {
  shutdown: () => Promise<void>;
};

export async function startNode(opts?: NodeOptions): Promise<NodeHandle> {
  const dbPath = opts?.dbPath ?? DEFAULT_DB_PATH;
  const peersFile = opts?.peersFile ?? PEERS_FILE;

  const peerManager = new PeerManager(new FilePeerStore(peersFile), logger);
  if (!opts?.isolated) {
    await peerManager.load();
  }

  const server = createServer();
  const objectsDb = new Level(`${dbPath}/objects`, { valueEncoding: "json" });
  const utxosDb = new Level<string, UtxoRow>(`${dbPath}/utxos`, {
    valueEncoding: "json",
  });
  await objectsDb.open();
  await utxosDb.open();
  const objectManager = new ObjectManager(logger, objectsDb);
  const utxoStore = new UtxoStore(logger, utxosDb);
  let minerController = null;
  if (MINER_ENABLED) {
    minerController = await initMiner(logger);
  }
  const transactionManager = new TransactionManager(
    objectManager,
    peerManager,
    logger,
    minerController,
  );
  const blockManager = new BlockManager(
    objectManager,
    utxoStore,
    peerManager,
    transactionManager,
    logger,
  );
  if (opts?.seed) {
    await blockManager.init(GENESIS_BLOCK, GENESIS_BLOCK_ID);
  } else {
    await blockManager.init();
  }

  if (MINER_ENABLED) {
    minerController?.onBlockMined(async (block: BlockMessage, coinbaseTx: TransactionMessage) => {
      logger.info(`Mined new block with id ${objectManager.id(block)}`);
      try {
        // Run through same validation+storage path as network-received txs.
        // Coinbase tx doesn't go to mempool (isCoinbaseCandidate check).
        await transactionManager.handleIncoming(coinbaseTx);
        await blockManager.handleIncoming(block);
      } catch (e) {
        logger.error(
          `Failed to handle mined block ${objectManager.id(block)}: ${(e as Error).message}`,
        );
      }
    });
    minerController?.onHashrateUpdate((report) => {
      logger.info(
        `Miner hashrate update: ${report.hashrate} H/s, current block height ${report.height}`,
      );
    });
  }
  try {
    // Do this so we know that the listening socket is properly set up before we run tests.
    logger.info(`Starting server on port ${SERVER_PORT}...`);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts?.port ?? SERVER_PORT, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    logger.error(`Error starting server: ${(err as Error).message} ${(err as Error).stack}`);
    await blockManager.close();
    process.exit(1);
  }

  const messageDispatcher = new MessageDispatcher(
    { block: blockManager, tx: transactionManager, peer: peerManager, object: objectManager },
    logger,
  );

  const ctx = {
    peerManager,
    logger,
    dispatcher: messageDispatcher,
  };

  server.on("connection", function (socket: Socket) {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;
    const connectedCtx: ConnectedPeerContext = {
      id,
      ...ctx,
    };
    handleInboundConnection(socket, connectedCtx);
  });
  handleOutboundConnection(ctx);
  const discoveryInterval = setInterval(() => handleOutboundConnection(ctx), 60000);

  return {
    shutdown: async () => {
      logger.info("Shutting down node...");
      clearInterval(discoveryInterval);

      try {
        // 1. Stop accepting new connections
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });

        // 2. Close the blockManager (which should close its internal stores)
        await blockManager.close();

        // 3. Explicitly close the DBs created in this scope just to be safe
        await objectsDb.close();
        await utxosDb.close();

        logger.info("Shutdown complete.");
      } catch (e) {
        logger.error(`Error during shutdown: ${(e as Error).message} ${(e as Error).stack}`);
      }
    },
  };
}

// Auto-start when run directly (not imported)
if (import.meta.main) {
  startNode();
}
