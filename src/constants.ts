export const SEPARATOR = "\n";
export const SERVER_PORT = 18018;
export const SERVER_HOST = "0.0.0.0";

export enum MessageType {
  HELLO = "hello",
  TEXT = "text",
  GET_PEERS = "getpeers",
  PEERS = "peers",
  ERROR = "error",
  GET_CHAIN_TIP = "getchaintip",
}

export const BOOTSTRAP_PEERS = [
  "95.179.158.137:18018",
  "95.179.132.22:18018",
  "45.32.235.245:18018",
];

export const PEERS_FILE = "./peers.json";
