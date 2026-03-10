export const SEPARATOR = "\n";
export const SERVER_PORT = 18018;
const isProd = process.env.NODE_ENV === "production";
export const SERVER_HOST = isProd ? "95.179.181.27" : "0.0.0.0";

export enum MessageType {
  HELLO = "hello",
  TEXT = "text",
  GET_PEERS = "getpeers",
  PEERS = "peers",
  ERROR = "error",
  GET_CHAIN_TIP = "getchaintip",
  GET_MEMPOOL = "getmempool",
  MEMPOOL = "mempool",
  TRANSACTION = "transaction",
}

export const BOOTSTRAP_PEERS = [
  "95.179.158.137:18018",
  "95.179.132.22:18018",
  "45.32.235.245:18018",
];

export const INVALID_SELF_HOSTS = ["localhost", "loopback"];

export const PEERS_FILE = "./peers.json";
export const MAX_PEERS = 1000;
export const OUTBOUND_PEER_LIMIT = 200;

export const DEFAULT_DB_PATH = "./marabudb";
export const DNS_BLACKLIST_TTL_MS = 60 * 60 * 1000;
