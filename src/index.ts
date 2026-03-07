import { createServer, Socket } from "net";
import logger from "./logger";
import { SERVER_PORT, PEERS_FILE } from "./constants";
import {
  handleInboundConnection,
  handleOutboundConnection,
} from "./connection";
import { PeerManager } from "./peerManager";
import { FilePeerStore } from "./peerStore";
import LevelDatabase from "./db";

async function startNode() {
  const peerManager = new PeerManager(new FilePeerStore(PEERS_FILE), logger);
  await peerManager.load();
  const server = createServer();
  const db = new LevelDatabase("");
  server.listen(SERVER_PORT, function () {
    console.log(
      `Server listening for connection requests on socket localhost:${SERVER_PORT}`,
    );
  });

  const ctx = {
    peerManager,
    logger,
    db,
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
