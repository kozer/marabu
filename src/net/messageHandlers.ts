import { MessageType } from "@/protocol/types";
import type {
  ValidMessage,
  HelloMessage,
  TextMessage,
  PeersMessage,
  GetPeersMessage,
  ErrorMessage,
  GetChainTipMessage,
  GetMempoolMessage,
  MempoolMessage,
  ConnectedPeerContext,
  IHaveObjectMessage,
  GetObjectMessage,
  ObjectMessage,
} from "@/protocol/types";
import { validatePeers } from "@/protocol/validator";
import { sendMessage } from "@/shared/utils";

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
  ctx: ConnectedPeerContext,
) => {
  console.log(`Received GET_PEERS message`);
  sendMessage(ctx.socket, {
    type: MessageType.PEERS,
    peers: ctx.peerManager.getPeersForAdvertisement(),
  });
};

export const peersHandler = async (
  message: PeersMessage,
  ctx: ConnectedPeerContext,
) => {
  validatePeers(message, ctx);
  const newPeers = [];
  for (const peer of message.peers) {
    const normalizedPeer = peer.trim();
    if (!ctx.peerManager.getKnownPeerSet().has(normalizedPeer)) {
      newPeers.push(normalizedPeer);
    }
  }
  await ctx.peerManager.addKnownPeers(newPeers, ctx.id);
};

export const errorHandler = async (
  message: ErrorMessage,
  ctx: ConnectedPeerContext,
) => {
  ctx.logger.error(
    `Received error from client: ${message.name} - ${message.description}`,
  );
};

export const getMempoolHandler = async (
  _message: GetMempoolMessage,
  ctx: ConnectedPeerContext,
) => {
  ctx.logger.info(
    `Received request for mempool from ${ctx.id}, but this functionality is not implemented yet.`,
  );
};

export const memPoolHandler = async (
  message: MempoolMessage,
  ctx: ConnectedPeerContext,
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
  ctx: ConnectedPeerContext,
) => {
  ctx.logger.info(
    `Received request for chain tip from ${ctx.id}, but this functionality is not implemented yet.`,
  );
};

export const iHaveObjectHandler = async (
  _message: IHaveObjectMessage,
  _ctx: ConnectedPeerContext,
) => {
  //TODO: Implement
};

export const getObjectHandler = async (
  _message: GetObjectMessage,
  _ctx: ConnectedPeerContext,
) => {
  //TODO: Implement
};

export const objectHandler = async (
  _message: ObjectMessage,
  _ctx: ConnectedPeerContext,
) => {
  //By now the objec we received is valid
  // TODO: Implement
};

type GenericHandler = (
  message: ValidMessage,
  ctx: ConnectedPeerContext,
) => Promise<void>;

export const messageHandlers: Record<
  MessageType,
  (message: ValidMessage, ctx: ConnectedPeerContext) => Promise<void>
> = {
  [MessageType.HELLO]: helloHandler as unknown as GenericHandler,
  [MessageType.TEXT]: textHandler as unknown as GenericHandler,
  [MessageType.GET_PEERS]: getPeersHandler as unknown as GenericHandler,
  [MessageType.PEERS]: peersHandler as unknown as GenericHandler,
  [MessageType.ERROR]: errorHandler as unknown as GenericHandler,
  [MessageType.GET_CHAIN_TIP]: getChainTipHandler as unknown as GenericHandler,
  [MessageType.GET_MEMPOOL]: getMempoolHandler as unknown as GenericHandler,
  [MessageType.MEMPOOL]: memPoolHandler as unknown as GenericHandler,
  [MessageType.IHAVEOBJECT]: iHaveObjectHandler as unknown as GenericHandler,
  [MessageType.GET_OBJECT]: getObjectHandler as unknown as GenericHandler,
  [MessageType.OBJECT]: objectHandler as unknown as GenericHandler,
};
