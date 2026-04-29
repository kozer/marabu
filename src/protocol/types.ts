import z from "zod";
import type { PeerManager } from "@/peers/peerManager";
import type ProtocolError from "@/protocol/error";
import type { MessageDispatcher } from "@/net/MessageDispatcher";
import type pino from "pino";
import { isTest } from "@/shared/constants";

export enum MessageType {
  HELLO = "hello",
  TEXT = "text",
  GET_PEERS = "getpeers",
  PEERS = "peers",
  ERROR = "error",
  GET_CHAIN_TIP = "getchaintip",
  CHAIN_TIP = "chaintip",
  GET_MEMPOOL = "getmempool",
  MEMPOOL = "mempool",
  IHAVEOBJECT = "ihaveobject",
  OBJECT = "object",
  GET_OBJECT = "getobject",
}

export enum ObjectType {
  TRANSACTION = "transaction",
  BLOCK = "block",
}

export const TARGET = isTest
  ? "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  : "00000000abc00000000000000000000000000000000000000000000000000000";

export const GENESIS_BLOCK_ID = isTest
  ? "968de9ad078cb00e0ea8f9e023aeba115588f4a9891daa7196a786c342dc60ee"
  : "00000000522473196b73bc619a8b18472c4cb4c6caf785a13fa32aaae7222ff6";

// TODO: Use it to seed database for PSET 3, to have a block to start from. Remove in PSET 4, and restore to objectManager.test.ts for testing purposes.
export const GENESIS_BLOCK: BlockMessage = isTest
  ? {
      T: TARGET,
      created: 1771159355,
      miner: "Marabu",
      nonce: "0000000000000000000000000000000000000000000000000000000000000000",
      note: "Financial Times 2026-02-13: Crypto battle",
      previd: null,
      txids: [],
      type: ObjectType.BLOCK,
    }
  : {
      T: TARGET,
      created: 1771159355,
      miner: "Marabu",
      nonce: "00dd82159556175752d9ba7349df67bddd237b59183747383f7b720e85c32347",
      note: "Financial Times 2026-02-13: Crypto's battle with the banks is splitting Trump's base",
      previd: null,
      txids: [],
      type: ObjectType.BLOCK,
    };

//50* 10^12 picabu
export const BLOCK_REWARD = 50 * 10 ** 12;
export enum ErrorCode {
  // An error occurred within the node while processing the message.
  INTERNAL_ERROR = "INTERNAL_ERROR",

  // The format of the received message is invalid.
  INVALID_FORMAT = "INVALID_FORMAT",

  // The object requested is unknown to that specific node.
  UNKNOWN_OBJECT = "UNKNOWN_OBJECT",

  // The object requested could not be found in the node's network.
  UNFINDABLE_OBJECT = "UNFINDABLE_OBJECT",

  // The peer sent other validly formatted messages before sending a valid hello message.
  INVALID_HANDSHAKE = "INVALID_HANDSHAKE",

  // The transaction outpoint index is too large.
  INVALID_TX_OUTPOINT = "INVALID_TX_OUTPOINT",

  // The transaction signature is invalid.
  INVALID_TX_SIGNATURE = "INVALID_TX_SIGNATURE",

  // The transaction does not satisfy the weak law of conservation.
  INVALID_TX_CONSERVATION = "INVALID_TX_CONSERVATION",

  // The block coinbase transaction is invalid.
  INVALID_BLOCK_COINBASE = "INVALID_BLOCK_COINBASE",

  // The block timestamp is invalid.
  INVALID_BLOCK_TIMESTAMP = "INVALID_BLOCK_TIMESTAMP",

  // The block proof-of-work is invalid.
  INVALID_BLOCK_POW = "INVALID_BLOCK_POW",

  // The block has a previd of null but it isn't genesis.
  INVALID_GENESIS = "INVALID_GENESIS",
}

export const HelloMessageSchema = z.object({
  type: z.literal(MessageType.HELLO),
  agent: z.string().optional(),
  version: z.string(),
});

export const GetMempoolMessageSchema = z.object({
  type: z.literal(MessageType.GET_MEMPOOL),
});

export const MempoolMessageSchema = z.object({
  type: z.literal(MessageType.MEMPOOL),
  txids: z.array(z.string()),
});

export const TextMessageSchema = z.object({
  type: z.literal(MessageType.TEXT),
  text: z.string().max(20),
});

export const GetPeersMessageSchema = z.object({
  type: z.literal(MessageType.GET_PEERS),
});

export const ErrorMessageSchema = z.object({
  type: z.literal(MessageType.ERROR),
  name: z.enum(ErrorCode),
  description: z.string(),
});

export const PeersMessageSchema = z.object({
  type: z.literal(MessageType.PEERS),
  peers: z.array(z.string()),
});

export const OutPointTransactionSchema = z.object({
  txid: z.hex().length(64),
  index: z.number().int().nonnegative(),
});

export const OutputTransactionSchema = z.object({
  pubkey: z.hex().length(64),
  value: z.number().int().nonnegative(),
});

export const InputTransactionSchema = z.object({
  outpoint: OutPointTransactionSchema,
  sig: z.hex().length(128).nullable(),
});

export const GetChainTipMessageSchema = z.object({
  type: z.literal(MessageType.GET_CHAIN_TIP),
});

export const ChainTipMessageSchema = z.object({
  type: z.literal(MessageType.CHAIN_TIP),
  blockid: z.hex().length(64),
});

export const GetOjbectMessageSchema = z.object({
  type: z.literal(MessageType.GET_OBJECT),
  objectid: z.hex().length(64),
});

export const IHaveObjectMessageSchema = z.object({
  type: z.literal(MessageType.IHAVEOBJECT),
  objectid: z.hex().length(64),
});

export const TransactionSchema = z.object({
  type: z.literal(ObjectType.TRANSACTION),
  height: z.number().int().nonnegative().optional(),
  inputs: z.array(InputTransactionSchema).optional(),
  outputs: z.array(OutputTransactionSchema),
});

const AsciiPrintableSchema = z
  .string()
  .max(128, "String must be 128 characters or fewer")
  .regex(/^[\x20-\x7E]*$/);

export const BlockSchema = z.object({
  type: z.literal(ObjectType.BLOCK),
  created: z.int().nonnegative(),
  nonce: z.hex().length(64),
  miner: AsciiPrintableSchema.optional(),
  note: AsciiPrintableSchema.optional(),
  previd: z.hex().length(64).nullable(),
  studentids: z.array(AsciiPrintableSchema).max(10).optional(),
  T: z.literal(TARGET),
  txids: z.array(z.hex().length(64)),
});

export const ObjectDataSchema = z.discriminatedUnion("type", [TransactionSchema, BlockSchema]);

export const ObjectMessageSchema = z.object({
  type: z.literal(MessageType.OBJECT),
  object: ObjectDataSchema,
});

export const MessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  TextMessageSchema,
  GetPeersMessageSchema,
  ErrorMessageSchema,
  PeersMessageSchema,
  GetChainTipMessageSchema,
  GetMempoolMessageSchema,
  MempoolMessageSchema,
  ObjectMessageSchema,
  IHaveObjectMessageSchema,
  GetOjbectMessageSchema,
  ChainTipMessageSchema,
]);

export type ValidMessage = z.infer<typeof MessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type TextMessage = z.infer<typeof TextMessageSchema>;
export type GetPeersMessage = z.infer<typeof GetPeersMessageSchema>;
export type PeersMessage = z.infer<typeof PeersMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type GetChainTipMessage = z.infer<typeof GetChainTipMessageSchema>;
export type ChainTipMessage = z.infer<typeof ChainTipMessageSchema>;
export type GetMempoolMessage = z.infer<typeof GetMempoolMessageSchema>;
export type MempoolMessage = z.infer<typeof MempoolMessageSchema>;
export type TransactionMessage = z.infer<typeof TransactionSchema>;
export type ObjectMessage = z.infer<typeof ObjectMessageSchema>;
export type ObjectData = z.infer<typeof ObjectDataSchema>;
export type BlockMessage = z.infer<typeof BlockSchema>;
export type IHaveObjectMessage = z.infer<typeof IHaveObjectMessageSchema>;
export type GetObjectMessage = z.infer<typeof GetOjbectMessageSchema>;
export type OutputTransactionMessage = z.infer<typeof OutputTransactionSchema>;
export type InputTransactionMessage = z.infer<typeof InputTransactionSchema>;
export type ResolvedInput = z.infer<typeof InputTransactionSchema> & {
  resolvedOutput: z.infer<typeof OutputTransactionSchema>;
};

export interface PeerContext {
  logger: any;
  dispatcher: MessageDispatcher;
  peerManager: PeerManager;
}
export type ConnectedPeerContext = PeerContext & {
  id: string;
};

export interface Connection {
  send(message: ValidMessage | ProtocolError): void;
  log: pino.Logger;
  readonly id: string;
}

export enum ConnectionDirection {
  INBOUND = "inbound",
  OUTBOUND = "outbound",
}

export type RegularTxAmounts = {
  inputValue: number;
  outputValue: number;
  fee: number;
};
export type TxEnriched = {
  resolvedInputs: ResolvedInput[];
  inputValue: number;
  outputValue: number;
  fee: number;
};

export type UtxoKey = `${string}:${number}`;

export type UtxoEntry = {
  txid: string;
  index: number;
  output: OutputTransactionMessage;
};

export type UtxoSnapshot = Map<UtxoKey, UtxoEntry>;
export type UtxoRow = UtxoEntry | string;

export type ValidateResult = {
  height: number;
  utxoSet: UtxoSnapshot;
};

export type ChainState = {
  tip: string;
  height: number;
};
