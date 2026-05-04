import ProtocolError from "@/protocol/error";
import { validatePeers } from "@/protocol/peer.validator";
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
  ChainTipMessage,
} from "@/protocol/types";
import type { ManagerSet } from "./MessageDispatcher";

export const helloHandler = async (message: HelloMessage, connection: Connection) => {
  connection.log.info(`Received HELLO message from ${message.agent} v${message.version}`);
};

export const textHandler = async (message: TextMessage, connection: Connection) => {
  connection.log.info(`Received TEXT message: ${message.text}`);
};

export const getPeersHandler = async (
  _message: GetPeersMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  connection.log.info(`Received GET_PEERS message from ${connection.id}`);
  connection.send({
    type: MessageType.PEERS,
    peers: managers.peer.getPeersForAdvertisement(),
  });
};

export const peersHandler = async (
  message: PeersMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  validatePeers(message);
  const newPeers = [];
  for (const peer of message.peers) {
    const normalizedPeer = peer.trim();
    if (!managers.peer.getKnownPeerSet().has(normalizedPeer)) {
      newPeers.push(normalizedPeer);
    }
  }
  await managers.peer.addKnownPeers(newPeers, connection.id);
};

export const errorHandler = async (message: ErrorMessage, connection: Connection) => {
  connection.log.error(`Received error from client: ${message.name} - ${message.description}`);
};

export const getMempoolHandler = async (
  _message: GetMempoolMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  const mempool = await managers.tx.getMempool();
  connection.send({
    type: MessageType.MEMPOOL,
    txids: mempool,
  });
};

export const memPoolHandler = async (
  message: MempoolMessage,
  _connection: Connection,
  managers: ManagerSet,
) => {
  const txids = message.txids;
  managers.tx.handleMempoolRequest(txids);
};

export const getChainTipHandler = async (
  _message: GetChainTipMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  const tip = managers.block.getTip();
  connection.send({
    type: MessageType.CHAIN_TIP,
    blockid: tip,
  });
};

export const iHaveObjectHandler = async (
  message: IHaveObjectMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  if (!(await managers.object.exists(message.objectid))) {
    connection.send({
      type: MessageType.GET_OBJECT,
      objectid: message.objectid,
    });
  }
};

export const getObjectHandler = async (
  message: GetObjectMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  try {
    const obj = await managers.object.get(message.objectid);
    if (obj) {
      connection.send({
        type: MessageType.OBJECT,
        object: obj,
      });
      return;
    }
  } catch (e) {
    connection.log.trace(`Error retrieving object ${message.objectid}: ${e}`);
  }
  throw new ProtocolError(ErrorCode.UNFINDABLE_OBJECT, `Object ${message.objectid} not found`);
};

export const objectHandler = async (
  message: ObjectMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  const objId = managers.object.id(message.object);
  connection.log.error(`Received object ${objId} from ${connection.id}`);
  if (message.object.type === ObjectType.TRANSACTION) {
    await managers.tx.handleIncoming(message.object);
  } else if (message.object.type === ObjectType.BLOCK) {
    await managers.block.handleIncoming(message.object);
  }
};

export const chainTipHandler = async (
  message: ChainTipMessage,
  _connection: Connection,
  managers: ManagerSet,
) => {
  if (managers.block.getTip() === message.blockid) {
    managers.peer.broadcast({
      type: MessageType.IHAVEOBJECT,
      objectid: message.blockid,
    });
    return;
  }
  if (await managers.object.exists(message.blockid)) {
    managers.peer.broadcast({
      type: MessageType.IHAVEOBJECT,
      objectid: message.blockid,
    });
    return; // We already have it, no need to process it again
  }
  await managers.block.handleIncoming(message.blockid);
};

type GenericHandler = (
  message: ValidMessage,
  connection: Connection,
  managers: ManagerSet,
) => Promise<void>;

export const messageHandlers: Record<
  MessageType,
  (message: ValidMessage, connection: Connection, managers: ManagerSet) => Promise<void>
> = {
  [MessageType.HELLO]: helloHandler as unknown as GenericHandler,
  [MessageType.TEXT]: textHandler as unknown as GenericHandler,
  [MessageType.GET_PEERS]: getPeersHandler as unknown as GenericHandler,
  [MessageType.PEERS]: peersHandler as unknown as GenericHandler,
  [MessageType.ERROR]: errorHandler as unknown as GenericHandler,
  [MessageType.GET_CHAIN_TIP]: getChainTipHandler as unknown as GenericHandler,
  [MessageType.CHAIN_TIP]: chainTipHandler as unknown as GenericHandler,
  [MessageType.GET_MEMPOOL]: getMempoolHandler as unknown as GenericHandler,
  [MessageType.MEMPOOL]: memPoolHandler as unknown as GenericHandler,
  [MessageType.IHAVEOBJECT]: iHaveObjectHandler as unknown as GenericHandler,
  [MessageType.GET_OBJECT]: getObjectHandler as unknown as GenericHandler,
  [MessageType.OBJECT]: objectHandler as unknown as GenericHandler,
};
