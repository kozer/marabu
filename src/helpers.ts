import { Socket } from "net";
import {
  BOOTSTRAP_PEERS,
  MessageType,
  PEERS_FILE,
  SEPARATOR,
} from "./constants";
import { MessageSchema, type ValidMessage } from "./types";
import canonicalize from "canonicalize";
import ProtocolError, { ErrorCode } from "./error";
import { semver } from "bun";
import logger from "./logger";

export function sendMessage(socket: Socket, message: ValidMessage) {
  const messageStr = canonicalize(message) + SEPARATOR;
  socket.write(messageStr);
}

export function handleConnection(
  socket: Socket,
  discoveredPeers: Set<string>,
  onSave: (peers: Set<string>) => Promise<void>,
  logger: any,
) {
  const id = `${socket.remoteAddress}:${socket.remotePort}`;
  if (discoveredPeers.has(id)) {
    logger.info(`Peer ${id} has reconnected.`);
  }
  logger.info(`A new connection has been established from ${id}.`);

  // Now that a TCP connection has been established, the server can send data to
  // the client by writing to its socket.
  sendMessage(socket, {
    type: MessageType.HELLO,
    version: "0.10.0",
    agent: "Sub zero node",
  });
  sendMessage(socket, {
    type: MessageType.GET_PEERS,
  });

  let hasHandshaked = false;
  let buffer = "";
  socket.on("data", async (data) => {
    buffer += data;
    const messages = buffer.split(SEPARATOR);
    buffer = messages.pop() || "";
    for (const msg of messages) {
      if (!msg.trim()) {
        logger.error(`Error defragmenting messages`);
        continue;
      }
      logger.info(`Message to parse ${msg}`);
      let message;
      try {
        message = JSON.parse(msg);
      } catch (error) {
        logger.error(`Error parsing message as JSON:`, message);
        socket.write(
          new ProtocolError(
            ErrorCode.INVALID_FORMAT,
            `Received message that is not valid JSON: ${error}`,
          ).toMessage(),
        );
        socket.end();
        return;
      }

      try {
        message = MessageSchema.parse(message);
      } catch (_) {
        logger.error(`Unknown protocol message`, message);
        socket.write(
          new ProtocolError(
            ErrorCode.INVALID_FORMAT,
            `Received message with invalid format`,
          ).toMessage(),
        );
        socket.end();
        return;
      }
      if (!hasHandshaked) {
        if (message.type !== MessageType.HELLO) {
          socket.write(
            new ProtocolError(
              ErrorCode.INVALID_HANDSHAKE,
              `Received message before handshake`,
            ).toMessage(),
          );
          socket.end();
          return;
        } else {
          const isValid = semver.satisfies(message.version, "0.10.x");
          if (!isValid) {
            socket.write(
              new ProtocolError(
                ErrorCode.INVALID_HANDSHAKE,
                `Incompatible client version ${message.version}`,
              ).toMessage(),
            );
            logger.error(
              `Received incompatible client version ${message.version}`,
            );
            socket.end();
            return;
          }
          hasHandshaked = true;
          discoveredPeers.add(id);
          sendMessage(socket, {
            type: MessageType.GET_PEERS,
          });
        }
      }
      if (message.type === MessageType.GET_PEERS) {
        sendMessage(socket, {
          type: MessageType.PEERS,
          peers: [...discoveredPeers],
        });
      }
      if (message.type === MessageType.PEERS) {
        for (const peer of message.peers) {
          if (!discoveredPeers.has(peer)) {
            logger.info(`Discovered new peer ${peer} from ${id}`);
            discoveredPeers.add(peer);
            await onSave(discoveredPeers);
          }
        }
      }
      if (message.type === MessageType.GET_CHAIN_TIP) {
        logger.info(
          `Received request for chain tip from ${id}, but this functionality is not implemented yet.`,
        );
      }
      if (message.type === MessageType.ERROR) {
        logger.error(
          `Received error from client: ${message.name} - ${message.description}`,
        );
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
}

export async function savePeers(peersSet: Set<string>) {
  try {
    const peersArray = [...peersSet];
    // Bun.write handles creating the file and writing the data automatically
    await Bun.write(
      PEERS_FILE,
      JSON.stringify(
        {
          peers: peersArray,
        },
        null,
        2,
      ),
    );
    logger.info(`Saved ${peersArray.length} peers to disk.`);
  } catch (err) {
    logger.error(err, "Failed to save peers to disk");
  }
}

export async function loadPeers(): Promise<Set<string>> {
  try {
    const file = Bun.file(PEERS_FILE);
    if (!(await file.exists())) {
      logger.info(
        `Peers file does not exist, starting with an empty peer set.`,
      );
    } else {
      const data = await file.json();
      const mergedPeers = [...BOOTSTRAP_PEERS, ...data.peers];
      return new Set(mergedPeers);
    }
  } catch (err) {
    logger.error(err, "Failed to load peers from disk");
  }
  return new Set(BOOTSTRAP_PEERS);
}
