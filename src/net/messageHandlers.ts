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
  Connection,
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
  connection: Connection,
) => {
  console.log(`Received GET_PEERS message`);
  connection.send({
    type: MessageType.PEERS,
    peers: connection.ctx.peerManager.getPeersForAdvertisement(),
  });
};

export const peersHandler = async (
  message: PeersMessage,
  connection: Connection,
) => {
  validatePeers(message, connection);
  const newPeers = [];
  for (const peer of message.peers) {
    const normalizedPeer = peer.trim();
    if (!connection.ctx.peerManager.getKnownPeerSet().has(normalizedPeer)) {
      newPeers.push(normalizedPeer);
    }
  }
  await connection.ctx.peerManager.addKnownPeers(newPeers, connection.id);
};

export const errorHandler = async (
  message: ErrorMessage,
  connection: Connection,
) => {
  connection.log.error(
    `Received error from client: ${message.name} - ${message.description}`,
  );
};

export const getMempoolHandler = async (
  _message: GetMempoolMessage,
  connection: Connection,
) => {
  connection.log.info(
    `Received request for mempool from ${connection.id}, but this functionality is not implemented yet.`,
  );
};

export const memPoolHandler = async (
  message: MempoolMessage,
  connection: Connection,
) => {
  connection.log.info(
    `Received mempool message from ${connection.id} with txids: ${message.txids.join(", ")}, but this functionality is not implemented yet.`,
  );
  connection.send({
    type: MessageType.MEMPOOL,
    txids: [],
  });
};

export const getChainTipHandler = async (
  _message: GetChainTipMessage,
  connection: Connection,
) => {
  connection.log.info(
    `Received request for chain tip from ${connection.id}, but this functionality is not implemented yet.`,
  );
};

export const iHaveObjectHandler = async (
  message: IHaveObjectMessage,
  connection: Connection,
) => {
  let hasObject = false;
  try {
    await connection.ctx.objectManager.get(message.objectid);
    hasObject = true;
  } catch (e) {}

  if (!hasObject) {
    connection.send({
      type: MessageType.GET_OBJECT,
      objectid: message.objectid,
    });
  }
};

export const getObjectHandler = async (
  message: GetObjectMessage,
  connection: Connection,
) => {
  try {
    const obj = await connection.ctx.objectManager.get(message.objectid);
    if (obj) {
      connection.send({
        type: MessageType.OBJECT,
        object: obj,
      });
      return;
    }
  } catch (e) {
    connection.log.error(`Error retrieving object ${message.objectid}: ${e}`);
  }
  connection.send(
    new ProtocolError(
      ErrorCode.UNFINDABLE_OBJECT,
      `Object ${message.objectid} not found`,
    ),
  );
};

export const objectHandler = async (
  message: ObjectMessage,
  connection: Connection,
) => {
  const objId = connection.ctx.objectManager.id(message.object);
  try {
    await connection.ctx.objectManager.get(objId);
    return;
  } catch (e) {}
  if (message.object.type === ObjectType.TRANSACTION) {
    if (isCoinbaseCandidate(message.object)) {
      try {
        // For coinbase transactions, we only do basic format checks since they are not fully valid until included in a block and validated as part of that block.
        checkCoinbaseFormat(message.object, connection);
      } catch (e) {
        if (e instanceof ProtocolError) {
          connection.send(e);
        }
        connection.log.error(`Error validating coinbase transaction: ${e}`);
        return;
      }
    } else {
      try {
        await validateRegularTx(message.object, connection);
      } catch (e) {
        if (e instanceof ProtocolError) {
          connection.send(e);
        }
        connection.log.error(`Error validating transaction: ${e}`);
        return;
      }
    }
  }
  if (message.object.type === ObjectType.BLOCK) {
    try {
      const result = await validateBlock(message.object, connection);
      if (!result) {
        //TODO:  Parent block unknown — ignore this block for PSET 3. Remove later
        connection.log.info(`Ignoring block ${objId}: parent block not found`);
        return;
      }
      await connection.ctx.blockManager.storeValidatedBlock(result);
      // Persist the block and its UTXO snapshot.
    } catch (e) {
      if (e instanceof ProtocolError) {
        connection.send(e);
      }
      connection.log.error(`Error validating block: ${e}`);
      return;
    }
  } else {
    // storeAccepted, adds block to the db. This is for txs.
    await connection.ctx.objectManager.put(message.object);
  }
  connection.ctx.peerManager.broadcast(
    {
      type: MessageType.IHAVEOBJECT,
      objectid: objId,
    },
    connection.id,
  );
};

type GenericHandler = (
  message: ValidMessage,
  connection: Connection,
) => Promise<void>;

export const messageHandlers: Record<
  MessageType,
  (message: ValidMessage, connection: Connection) => Promise<void>
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
