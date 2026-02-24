export const SEPARATOR = "\n";
export const SERVER_PORT = 18018;
const isProd = process.env.NODE_ENV === "production";
export const SERVER_HOST = isProd ? "95.179.181.27" : "127.0.0.1";
export const MY_NODE_ADDRESS = isProd
  ? "95.179.181.27:18018"
  : "127.0.0.1:18018";

export enum MessageType {
  HELLO = "hello",
  TEXT = "text",
  GET_PEERS = "getpeers",
  PEERS = "peers",
  ERROR = "error",
  GET_CHAIN_TIP = "getchaintip",
  GET_MEMPOOL = "getmempool",
  MEMPOOL = "mempool",
}

export const BOOTSTRAP_PEERS = [
  "95.179.158.137:18018",
  "95.179.132.22:18018",
  "45.32.235.245:18018",
];

export const PEERS_FILE = "./peers.json";
export const MAX_PEERS = 20;
export const OUTBOUND_PEER_LIMIT = 10;
