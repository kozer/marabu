import z from "zod";
import { MessageType } from "./constants";
import { ErrorCode } from "./error";
import { validateHost } from "./utils";
import { Socket } from "net";
import type { PeerManager } from "./peerManager";

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

export const PeerSchema = z.string().refine(validateHost, {
  message:
    "Invalid peer format. Expected 'host:port', 'ipv4:port', or '[ipv6]:port'",
});

export const PeersMessageSchema = z.object({
  type: z.literal(MessageType.PEERS),
  peers: z.array(PeerSchema),
});

export const GetChainTipMessageSchema = z.object({
  type: z.literal(MessageType.GET_CHAIN_TIP),
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

export interface PeerContext {
  socket: Socket;
  id: string;
  peerManager: PeerManager;
  logger: any;
}
