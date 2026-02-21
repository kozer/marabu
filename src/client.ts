import canonicalize from "canonicalize";
import logger from "./logger";
import { Socket } from "net";
import {
  BOOTSTRAP_PEERS,
  SEPARATOR,
  SERVER_HOST,
  SERVER_PORT,
} from "./constants";
import { handleConnection, savePeers } from "./helpers";

logger.info(
  `Starting client and connecting to server at ${SERVER_HOST}:${SERVER_PORT}`,
);
const client = new Socket();
client.connect(SERVER_PORT, SERVER_HOST, () => {
  console.log("Connected to server");
  handleConnection(client, new Set(BOOTSTRAP_PEERS), savePeers, logger);
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
