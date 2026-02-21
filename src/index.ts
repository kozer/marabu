import { createServer } from "net";
import { MessageSchema } from "./types";
import logger from "./logger";
import { SEPARATOR, SERVER_PORT } from "./constants";
import canonicalize from "canonicalize";

// The port number and hostname of the server.

const server = createServer();
// The server listens to a socket for a client to make a connection request.
// Think of a socket as an end point.
server.listen(SERVER_PORT, function () {
  console.log(
    `Server listening for connection requests on socket localhost:${SERVER_PORT}`,
  );
});

// When a client requests a connection with the server, the server creates a new
// socket dedicated to that client.
server.on("connection", function (socket) {
  const id = `${socket.remoteAddress}:${socket.remotePort}`;
  logger.info(`A new connection has been established from ${id}.`);

  // Now that a TCP connection has been established, the server can send data to
  // the client by writing to its socket.
  socket.write("Hello, client" + SEPARATOR);

  // I'll do it like this in order to test things where things are coming in very small chunks.
  // socket.on("readable", function () {
  //   let chunk;
  //   while (null !== (chunk = socket.read(10))) {}
  // });

  let buffer = "";
  socket.on("data", (data) => {
    buffer += data;
    logger.info(`Current Buffer State: "${buffer}"`);
    const messages = buffer.split(SEPARATOR);
    buffer = messages.pop() || "";
    for (const msg of messages) {
      if (!msg.trim()) {
        logger.error(`Error defragmenting messages`);
        return;
      }
      logger.info(`Message to parse ${msg}`);
      let message;
      try {
        message = JSON.parse(msg);
      } catch (error) {
        logger.error(`Error parsing message as JSON:`, message);
        socket.write(
          `Received invalid message that could not parse as JSON: ` + msg,
        );
        continue;
      }

      try {
        message = MessageSchema.parse(message);
      } catch (_) {
        logger.error(`Unknown protocol message`, message);
        socket.write(
          `Received invalid protocol message: ` + JSON.stringify(message),
        );
        continue;
      }

      logger.info(message, `[${id}]: Received message`);
    }
  });

  socket.on("end", function () {
    logger.info("Closing connection with the client");
  });

  socket.on("error", function (err) {
    logger.info(`Error: ${err}`);
  });
});
