import { createServer, Socket } from "net";
import { Level } from "level";
import logger from "@/shared/logger";
import { SERVER_PORT, PEERS_FILE, DEFAULT_DB_PATH } from "@/shared/constants";
import { handleInboundConnection, handleOutboundConnection } from "@/net/connection";
import { PeerManager } from "@/peers/peerManager";
import { FilePeerStore } from "@/peers/peerStore";
import ObjectManager from "./storage/objectManager";
import type { ConnectedPeerContext, UtxoRows } from "./protocol/types";
import UtxoStore from "./storage/UtxoStore";
import BlockManager from "./storage/BlockManager";
import { GENESIS_BLOCK, GENESIS_BLOCK_ID } from "./protocol/types";
import { MessageDispatcher } from "./net/MessageDispatcher";
import { TransactionManager } from "./storage/TransactionManager";

export type NodeOptions = {
  dbPath?: string;
  peersFile?: string;
};

export type NodeHandle = {
  shutdown: () => Promise<void>;
};

export async function startNode(opts?: NodeOptions): Promise<NodeHandle> {
  const dbPath = opts?.dbPath ?? DEFAULT_DB_PATH;
  const peersFile = opts?.peersFile ?? PEERS_FILE;

  const peerManager = new PeerManager(new FilePeerStore(peersFile), logger);
  await peerManager.load();
  const server = createServer();
  const objectsDb = new Level(`${dbPath}/objects`, { valueEncoding: "json" });
  const utxosDb = new Level<string, UtxoRows>(`${dbPath}/utxos`, {
    valueEncoding: "json",
  });
  const objectManager = new ObjectManager(logger, objectsDb);
  const utxoStore = new UtxoStore(logger, utxosDb);
  const transactionManager = new TransactionManager(objectManager, peerManager, logger);
  const blockManager = new BlockManager(
    objectManager,
    utxoStore,
    peerManager,
    transactionManager,
    logger,
  );
  // TODO: Remove after PSET 3.
  await blockManager.seedGenesis(GENESIS_BLOCK, GENESIS_BLOCK_ID);

  try {
    // Do this so we know that the listening socket is properly set up before we run tests.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(SERVER_PORT, () => {
        server.removeListener("error", reject);
        console.log(`Server listening for connection requests on socket localhost:${SERVER_PORT}`);
        resolve();
      });
    });
  } catch (err) {
    logger.error(`Error starting server: ${(err as Error).message}`);
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
        logger.error(`Error during shutdown: ${(e as Error).message}`);
      }
    },
  };
}

// Auto-start when run directly (not imported)
if (import.meta.main) {
  startNode();
}
