import z from "zod";
import { MessageType } from "./constants";
import { ErrorCode } from "./error";

export const HelloMessageSchema = z.object({
  type: z.literal(MessageType.HELLO),
  agent: z.string(),
  version: z.string(),
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

export const PeerSchema = z.string().refine(
  (str) => {
    const lastColon = str.lastIndexOf(":");
    if (lastColon === -1) {
      return false;
    }
    const host = str.slice(0, lastColon);
    const port = str.slice(lastColon + 1);

    if (!host || !port) {
      return false;
    }
    const portNum = parseInt(port, 10);
    return Number.isInteger(portNum) && portNum > 0 && portNum <= 65535;
  },
  {
    message:
      "Invalid peer format. Expected 'host:port', 'ipv4:port', or '[ipv6]:port'",
  },
);

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
]);

export type ValidMessage = z.infer<typeof MessageSchema>;
