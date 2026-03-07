import z from "zod";
import { MessageType } from "./constants";
import { ErrorCode } from "./error";
import { Socket } from "net";
import type { PeerManager } from "./peerManager";
import type { DatabaseInterface } from "./db";

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

export const TransactionSchema = z.object({
  type: z.literal(MessageType.TRANSACTION),
  height: z.number().int().nonnegative().optional(),
  inputs: z.array(InputTransactionSchema).optional(),
  outputs: z.array(OutputTransactionSchema),
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
  TransactionSchema,
]);

export type ValidMessage = z.infer<typeof MessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type TextMessage = z.infer<typeof TextMessageSchema>;
export type GetPeersMessage = z.infer<typeof GetPeersMessageSchema>;
export type PeersMessage = z.infer<typeof PeersMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type GetChainTipMessage = z.infer<typeof GetChainTipMessageSchema>;
export type GetMempoolMessage = z.infer<typeof GetMempoolMessageSchema>;
export type MempoolMessage = z.infer<typeof MempoolMessageSchema>;
export type TransactionMessage = z.infer<typeof TransactionSchema>;

export interface PeerContext {
  peerManager: PeerManager;
  logger: any;
  db: DatabaseInterface;
}
export type ConnectedPeerContext = PeerContext & {
  socket: Socket;
  id: string;
};
