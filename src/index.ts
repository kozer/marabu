import { createServer, Socket } from "net";
import logger from "@/shared/logger";
import { SERVER_PORT, PEERS_FILE } from "@/shared/constants";
import {
  handleInboundConnection,
  handleOutboundConnection,
} from "@/net/connection";
import { PeerManager } from "@/peers/peerManager";
import { FilePeerStore } from "@/peers/peerStore";
import ObjectManager from "./storage/objectManager";
import UtxoStore from "./storage/UtxoStore";
import BlockManager from "./storage/BlockManager";
import { GENESIS_BLOCK, GENESIS_BLOCK_ID } from "./protocol/types";

export type NodeHandle = {
  shutdown: () => Promise<void>;
};

export async function startNode(): Promise<NodeHandle> {
  const peerManager = new PeerManager(new FilePeerStore(PEERS_FILE), logger);
  await peerManager.load();
  const server = createServer();
  const objectManager = new ObjectManager();
  const utxoStore = new UtxoStore();
  const blockManager = new BlockManager(objectManager, utxoStore);
  // TODO: Remove after PSET 3.
  await blockManager.seedGenesis(GENESIS_BLOCK, GENESIS_BLOCK_ID);

  try {
    // Do this so we know that the listening socket is properly set up before we run tests.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(SERVER_PORT, () => {
        server.removeListener("error", reject);
        console.log(
          `Server listening for connection requests on socket localhost:${SERVER_PORT}`,
        );
        resolve();
      });
    });
  } catch (err) {
    // Clean up already-opened resources before propagating
    await objectManager.close().catch(() => {});
    await utxoStore.close().catch(() => {});
    throw err;
  }

  const ctx = {
    peerManager,
    logger,
    objectManager,
    blockManager,
  };
  server.on("connection", function (socket: Socket) {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;
    const connectedCtx = {
      id,
      socket,
      ...ctx,
    };
    handleInboundConnection(connectedCtx);
  });
  handleOutboundConnection(ctx);
  const discoveryInterval = setInterval(
    () => handleOutboundConnection(ctx),
    60000,
  );

  return {
    shutdown: async () => {
      clearInterval(discoveryInterval);
      const errors: Error[] = [];
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      } catch (e) {
        errors.push(e as Error);
      }
      try {
        await objectManager.close();
      } catch (e) {
        errors.push(e as Error);
      }
      try {
        await utxoStore.close();
      } catch (e) {
        errors.push(e as Error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Shutdown encountered errors");
      }
    },
  };
}

// Auto-start when run directly (not imported)
if (import.meta.main) {
  startNode();
}
