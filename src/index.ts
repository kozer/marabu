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

async function startNode() {
  const peerManager = new PeerManager(new FilePeerStore(PEERS_FILE), logger);
  await peerManager.load();
  const server = createServer();
  const objectManager = new ObjectManager();
  const utxoStore = new UtxoStore();
  const blockManager = new BlockManager(objectManager, utxoStore);
  server.listen(SERVER_PORT, function () {
    console.log(
      `Server listening for connection requests on socket localhost:${SERVER_PORT}`,
    );
  });

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
  setInterval(() => handleOutboundConnection(ctx), 60000);
}

startNode();
