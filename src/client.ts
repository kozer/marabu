import canonicalize from "canonicalize";
import logger from "./logger";
import { Socket } from "net";
import { MessageSchema } from "./types";
import { SEPARATOR, SERVER_HOST, SERVER_PORT } from "./constants";

logger.info(
  `Starting client and connecting to server at ${SERVER_HOST}:${SERVER_PORT}`,
);
const client = new Socket();
client.connect(SERVER_PORT, SERVER_HOST, () => {
  console.log("Connected to server");
});

const helloMessage = {
  type: "hello",
  agent: "client-example",
};
client.write(canonicalize(helloMessage) + SEPARATOR);

const textMessage = {
  type: "text",
  text: "This is short",
};
client.write(canonicalize(textMessage) + SEPARATOR);

const invalidMessage1 = {
  type: "unknown type",
};
client.write(canonicalize(invalidMessage1) + SEPARATOR);

const invalidMessage2 = {
  type: "text",
  text: "This is a text message that is way too long and the server will not accept it",
};
client.write(canonicalize(invalidMessage2) + SEPARATOR);

let buffer = "";
client.on("data", (data) => {
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
      logger.error(`Error parsing message as JSON`, message);
      client.write(
        `Received invalid message that could not parse as JSON: ` + msg,
      );
      continue;
    }

    try {
      message = MessageSchema.parse(message);
    } catch (_) {
      logger.error(`Unknown protocol message`, message);
      client.write(
        `Received invalid protocol message: ` + JSON.stringify(message),
      );
      continue;
    }
  }
});

client.on("error", (error) => {
  console.error(`Received error ${error}`);
});

client.on("close", () => {
  console.log(`Client disconnected`);
});
