export const SEPARATOR = "\n";
export const SERVER_PORT = 18018;
const isProd = process.env.NODE_ENV === "production";
export const SERVER_HOST = isProd ? "95.179.181.27" : "0.0.0.0";

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
export const FIND_TIMEOUT_MS = 5000;

export const MAX_PEERS_FROM_MESSAGE = 32;
export const MAX_PEERS_PER_SOURCE = 64;
export const STALE_PEER_MAX_AGE_TTL = 2 * 24 * 60 * 60 * 1000;
export const INVALID_MESSAGE_THRESHOLD = 100;
export const INVALID_MESSAGE_BLACKLIST_TTL = 60 * 1000;
