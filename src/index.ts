import { createServer, Socket } from "net";
import logger from "./logger";
import { SERVER_PORT } from "./constants";
import {
  handleInboundConnection,
  handleOutboundConnection,
} from "./connection";
import { PeerManager } from "./peerManager";

async function startNode() {
  const peerManager = new PeerManager();
  await peerManager.load();
  const server = createServer();
  server.listen(SERVER_PORT, function () {
    console.log(
      `Server listening for connection requests on socket localhost:${SERVER_PORT}`,
    );
  });
  server.on("connection", function (socket: Socket) {
    handleInboundConnection(socket, peerManager, logger);
  });
  handleOutboundConnection(peerManager, logger);
  setInterval(() => handleOutboundConnection(peerManager, logger), 10000);
}

startNode();
