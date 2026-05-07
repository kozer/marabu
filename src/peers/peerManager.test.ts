import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryPeerStore } from "@/peers/peerStore";
import { PeerManager } from "@/peers/peerManager";
import { INVALID_MESSAGE_THRESHOLD } from "@/shared/constants";

const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
  trace: (..._args: any[]) => {},
};

describe("PeerManager", () => {
  let store: MemoryPeerStore;
  let peerManager: PeerManager;

  beforeEach(async () => {
    store = new MemoryPeerStore();
    peerManager = new PeerManager(store, logger);
    await peerManager.load();
  });

  test("caps accepted peers from a single source", async () => {
    const peers = Array.from({ length: 80 }, (_, index) => `203.0.113.${index + 1}:18018`);

    await peerManager.addKnownPeers(peers, "198.51.100.10:18018");

    const acceptedPeers = peerManager
      .getKnownPeers()
      .filter((peer) => peer.startsWith("203.0.113."));

    expect(acceptedPeers.length).toBe(32);
  });

  test("prunes stale peers with repeated failures and no success", async () => {
    const stalePeer = "198.51.100.77:18018";
    await peerManager.addKnownPeers([stalePeer], "198.51.100.10:18018");

    await peerManager.reportConnectionFailure(stalePeer);
    await peerManager.reportConnectionFailure(stalePeer);
    await peerManager.reportConnectionFailure(stalePeer);

    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const pruned = await peerManager.pruneStalePeers(Date.now() + threeDaysMs);

    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(peerManager.getKnownPeers()).not.toContain(stalePeer);
  });

  test("blacklisting a connection host suppresses matching known peers", async () => {
    const knownPeer = "198.51.100.88:18018";
    const inboundConnectionId = "198.51.100.88:54321";
    await peerManager.addKnownPeers([knownPeer], "198.51.100.10:18018");

    for (let i = 0; i < INVALID_MESSAGE_THRESHOLD; i += 1) {
      await peerManager.reportInvalidPeerMessage(inboundConnectionId, "bad data");
    }

    expect(peerManager.getKnownPeers()).toContain(knownPeer);
    expect(peerManager.getOutboundCandidates()).not.toContain(knownPeer);
  });

  test("does not persist temporary peer penalties across reload", async () => {
    const badPeer = "198.51.100.99:18018";
    const flakyPeer = "198.51.100.100:18018";
    await peerManager.addKnownPeers([badPeer, flakyPeer], "198.51.100.10:18018");

    for (let i = 0; i < INVALID_MESSAGE_THRESHOLD; i += 1) {
      await peerManager.reportInvalidPeerMessage(badPeer, "bad data");
    }

    for (let i = 0; i < 6; i += 1) {
      await peerManager.reportConnectionFailure(flakyPeer);
    }

    expect(peerManager.getOutboundCandidates()).not.toContain(flakyPeer);

    const reloadedPeerManager = new PeerManager(store, logger);
    await reloadedPeerManager.load();

    expect(store.getPeers()).toEqual(expect.arrayContaining([badPeer, flakyPeer]));
    expect(reloadedPeerManager.getKnownPeers()).toContain(flakyPeer);
    expect(reloadedPeerManager.getKnownPeers()).toContain(badPeer);
  });

  test("successful outbound connection clears dial backoff without clearing blacklist", async () => {
    const peer = "198.51.100.101:18018";
    const connection = {
      id: peer,
      send: () => {},
      context: {
        socket: {
          destroy: () => {},
        },
      },
    } as any;

    await peerManager.addKnownPeers([peer], "198.51.100.10:18018");

    await peerManager.reportConnectionFailure(peer);
    expect(peerManager.getOutboundCandidates()).not.toContain(peer);

    peerManager.onSuccessfulHandshake(peer);

    expect(peerManager.getOutboundCandidates()).toContain(peer);

    for (let i = 0; i < INVALID_MESSAGE_THRESHOLD; i += 1) {
      await peerManager.reportInvalidPeerMessage(peer, "bad data");
    }
    peerManager.registerOutboundConnection(connection);
    peerManager.unregisterConnection(peer);

    expect(peerManager.getOutboundCandidates()).not.toContain(peer);
  });

  test("successful inbound connection clears dial backoff for the same host", async () => {
    const peer = "198.51.100.102:18018";

    await peerManager.addKnownPeers([peer], "198.51.100.10:18018");
    await peerManager.reportConnectionFailure(peer);

    expect(peerManager.getOutboundCandidates()).not.toContain(peer);

    peerManager.onSuccessfulHandshake(peer);

    expect(peerManager.getOutboundCandidates()).toContain(peer);
  });

  test("does not create peer records for unknown invalid clients", async () => {
    const unknownPeer = "198.51.100.200:54321";

    await peerManager.reportInvalidPeerMessage(unknownPeer, "bad data");

    expect(peerManager.getKnownPeers()).not.toContain(unknownPeer);
  });
});
