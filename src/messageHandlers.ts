import { MessageType } from "./constants";
import type {
  PeerContext,
  ValidMessage,
  HelloMessage,
  TextMessage,
  PeersMessage,
  GetPeersMessage,
  ErrorMessage,
  GetChainTipMessage,
  GetMempoolMessage,
  MempoolMessage,
} from "./types";
import { sendMessage } from "./utils";

export const helloHandler = async (message: HelloMessage) => {
  console.log(
    `Received HELLO message from ${message.agent} v${message.version}`,
  );
};

export const textHandler = async (message: TextMessage) => {
  console.log(`Received TEXT message: ${message.text}`);
};

export const getPeersHandler = async (
  _message: GetPeersMessage,
  ctx: PeerContext,
) => {
  console.log(`Received GET_PEERS message`);
  sendMessage(ctx.socket, {
    type: MessageType.PEERS,
    peers: ctx.peerManager.getAll(),
  });
};

export const peersHandler = async (message: PeersMessage, ctx: PeerContext) => {
  const newPeers = [];
  for (const peer of message.peers) {
    const normalizedPeer = peer.trim();
    if (!ctx.peerManager.getPeers().has(normalizedPeer)) {
      newPeers.push(normalizedPeer);
    }
  }
  await ctx.peerManager.addAll(newPeers);
};

export const errorHandler = async (message: ErrorMessage, ctx: PeerContext) => {
  ctx.logger.error(
    `Received error from client: ${message.name} - ${message.description}`,
  );
};

export const getMempoolHandler = async (
  _message: GetMempoolMessage,
  ctx: PeerContext,
) => {
  ctx.logger.info(
    `Received request for mempool from ${ctx.id}, but this functionality is not implemented yet.`,
  );
};

export const memPoolHandler = async (
  message: MempoolMessage,
  ctx: PeerContext,
) => {
  ctx.logger.info(
    `Received mempool message from ${ctx.id} with txids: ${message.txids.join(", ")}, but this functionality is not implemented yet.`,
  );
  sendMessage(ctx.socket, {
    type: MessageType.MEMPOOL,
    txids: [],
  });
};

export const getChainTipHandler = async (
  _message: GetChainTipMessage,
  ctx: PeerContext,
) => {
  ctx.logger.info(
    `Received request for chain tip from ${ctx.id}, but this functionality is not implemented yet.`,
  );
};

export const transactionHandler = async (
  _message: ValidMessage,
  ctx: PeerContext,
) => {
  ctx.logger.info(
    `Received transaction message from ${ctx.id}, but transaction handling is not implemented yet.`,
  );
};

type GenericHandler = (
  message: ValidMessage,
  ctx: PeerContext,
) => Promise<void>;

export const messageHandlers: Record<
  MessageType,
  (message: ValidMessage, ctx: PeerContext) => Promise<void>
> = {
  [MessageType.HELLO]: helloHandler as unknown as GenericHandler,
  [MessageType.TEXT]: textHandler as unknown as GenericHandler,
  [MessageType.GET_PEERS]: getPeersHandler as unknown as GenericHandler,
  [MessageType.PEERS]: peersHandler as unknown as GenericHandler,
  [MessageType.ERROR]: errorHandler as unknown as GenericHandler,
  [MessageType.GET_CHAIN_TIP]: getChainTipHandler as unknown as GenericHandler,
  [MessageType.GET_MEMPOOL]: getMempoolHandler as unknown as GenericHandler,
  [MessageType.MEMPOOL]: memPoolHandler as unknown as GenericHandler,
  [MessageType.TRANSACTION]: transactionHandler as unknown as GenericHandler,
};
