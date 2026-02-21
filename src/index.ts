import { createServer, Socket } from "net";
import logger from "./logger";
import { SERVER_PORT } from "./constants";
import { handleConnection, loadPeers, savePeers } from "./helpers";

const server = createServer();
// The server listens to a socket for a client to make a connection request.
// Think of a socket as an end point.
server.listen(SERVER_PORT, function () {
  console.log(
    `Server listening for connection requests on socket localhost:${SERVER_PORT}`,
  );
});

const discoveredPeers = await loadPeers();

// When a client requests a connection with the server, the server creates a new
// socket dedicated to that client.
server.on("connection", function (socket: Socket) {
  handleConnection(socket, discoveredPeers, savePeers, logger);
});

async function bootStrapNetwork() {
  for (const peer of discoveredPeers) {
    // Parse the host and port (you might want to use your safer parsing logic here)
    const [host, portStr] = peer.split(":");
    if (!host || !portStr) {
      logger.warn(`Invalid bootstrap peer format: ${peer}`);
      continue;
    }
    const port = parseInt(portStr, 10);

    logger.info(`Dialing outbound connection to bootstrap peer: ${peer}`);

    const clientSocket = new Socket();

    clientSocket.connect(port, host, () => {
      logger.info(`Successfully connected to ${peer}!`);
      handleConnection(clientSocket, discoveredPeers, savePeers, logger);
    });

    clientSocket.on("error", (err) => {
      logger.warn(
        `Failed to connect to bootstrap peer ${peer}: ${err.message}`,
      );
    });
  }
}

bootStrapNetwork();
