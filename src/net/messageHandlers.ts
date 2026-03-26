import ProtocolError from "@/protocol/error";
import { ErrorCode, MessageType, ObjectType } from "@/protocol/types";
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
import {
  checkCoinbaseFormat,
  isCoinbaseCandidate,
  validateBlock,
  validatePeers,
  validateRegularTx,
} from "@/protocol/validator";
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
  message: IHaveObjectMessage,
  ctx: ConnectedPeerContext,
) => {
  let hasObject = false;
  try {
    await ctx.objectManager.get(message.objectid);
    hasObject = true;
  } catch (e) {}

  if (!hasObject) {
    sendMessage(ctx.socket, {
      type: MessageType.GET_OBJECT,
      objectid: message.objectid,
    });
  }
};

export const getObjectHandler = async (
  message: GetObjectMessage,
  ctx: ConnectedPeerContext,
) => {
  try {
    const obj = await ctx.objectManager.get(message.objectid);
    if (obj) {
      sendMessage(ctx.socket, {
        type: MessageType.OBJECT,
        object: obj,
      });
      return;
    }
  } catch (e) {
    ctx.logger.error(`Error retrieving object ${message.objectid}: ${e}`);
  }
  sendMessage(
    ctx.socket,
    new ProtocolError(
      ErrorCode.UNFINDABLE_OBJECT,
      `Object ${message.objectid} not found`,
    ),
  );
};

export const objectHandler = async (
  message: ObjectMessage,
  ctx: ConnectedPeerContext,
) => {
  const objId = ctx.objectManager.id(message.object);
  try {
    await ctx.objectManager.get(objId);
    return;
  } catch (e) {}
  if (message.object.type === ObjectType.TRANSACTION) {
    if (isCoinbaseCandidate(message.object)) {
      try {
        // For coinbase transactions, we only do basic format checks since they are not fully valid until included in a block and validated as part of that block.
        checkCoinbaseFormat(message.object, ctx);
      } catch (e) {
        if (e instanceof ProtocolError) {
          sendMessage(ctx.socket, e);
        }
        ctx.logger.error(`Error validating coinbase transaction: ${e}`);
        return;
      }
    } else {
      try {
        await validateRegularTx(message.object, ctx);
      } catch (e) {
        if (e instanceof ProtocolError) {
          sendMessage(ctx.socket, e);
        }
        ctx.logger.error(`Error validating transaction: ${e}`);
        return;
      }
    }
  }
  if (message.object.type === ObjectType.BLOCK) {
    try {
      const result = await validateBlock(message.object, ctx);
      if (!result) {
        //TODO:  Parent block unknown — ignore this block for PSET 3. Remove later
        ctx.logger.info(`Ignoring block ${objId}: parent block not found`);
        return;
      }
      await ctx.blockManager.storeValidatedBlock(result);
      // Persist the block and its UTXO snapshot.
    } catch (e) {
      if (e instanceof ProtocolError) {
        sendMessage(ctx.socket, e);
      }
      ctx.logger.error(`Error validating block: ${e}`);
      return;
    }
  } else {
    // storeAccepted, adds block to the db. This is for txs.
    await ctx.objectManager.put(message.object);
  }
  ctx.peerManager.broadcast(
    {
      type: MessageType.IHAVEOBJECT,
      objectid: objId,
    },
    ctx.id,
  );
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
