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
} from "@/protocol/types";
import type { ManagerSet } from "./MessageDispatcher";

export const helloHandler = async (message: HelloMessage) => {
  console.log(`Received HELLO message from ${message.agent} v${message.version}`);
};

export const textHandler = async (message: TextMessage) => {
  console.log(`Received TEXT message: ${message.text}`);
};

export const getPeersHandler = async (
  _message: GetPeersMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  console.log(`Received GET_PEERS message`);
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

export const getMempoolHandler = async (_message: GetMempoolMessage, connection: Connection) => {
  connection.log.info(
    `Received request for mempool from ${connection.id}, but this functionality is not implemented yet.`,
  );
};

export const memPoolHandler = async (message: MempoolMessage, connection: Connection) => {
  connection.log.info(
    `Received mempool message from ${connection.id} with txids: ${message.txids.join(", ")}, but this functionality is not implemented yet.`,
  );
  connection.send({
    type: MessageType.MEMPOOL,
    txids: [],
  });
};

export const getChainTipHandler = async (_message: GetChainTipMessage, connection: Connection) => {
  connection.log.info(
    `Received request for chain tip from ${connection.id}, but this functionality is not implemented yet.`,
  );
};

export const iHaveObjectHandler = async (
  message: IHaveObjectMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  let hasObject = false;
  try {
    await managers.object.get(message.objectid);
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
    connection.log.error(`Error retrieving object ${message.objectid}: ${e}`);
  }
  connection.send(
    new ProtocolError(ErrorCode.UNFINDABLE_OBJECT, `Object ${message.objectid} not found`),
  );
};

export const objectHandler = async (
  message: ObjectMessage,
  connection: Connection,
  managers: ManagerSet,
) => {
  const objId = managers.object.id(message.object);
  try {
    await managers.object.get(objId);
    return;
  } catch (e) {}
  try {
    if (message.object.type === ObjectType.TRANSACTION) {
      // 2. Delegate to Tx Manager
      await managers.tx.handleIncoming(message.object, connection);
    } else if (message.object.type === ObjectType.BLOCK) {
      // 2. Delegate to Block Manager
      await managers.block.handleIncoming(message.object, connection);
    }
  } catch (e) {
    // Errors bubble up here from the managers
    if (e instanceof ProtocolError) {
      connection.send(e);
    }
    connection.log.error(`Failed to handle object ${objId}: ${(e as Error).message}`);
  }
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
  [MessageType.GET_MEMPOOL]: getMempoolHandler as unknown as GenericHandler,
  [MessageType.MEMPOOL]: memPoolHandler as unknown as GenericHandler,
  [MessageType.IHAVEOBJECT]: iHaveObjectHandler as unknown as GenericHandler,
  [MessageType.GET_OBJECT]: getObjectHandler as unknown as GenericHandler,
  [MessageType.OBJECT]: objectHandler as unknown as GenericHandler,
};
