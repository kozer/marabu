import { beforeEach, describe, expect, test } from "bun:test";
import { MemoryPeerStore } from "@/peers/peerStore";
import { PeerManager } from "@/peers/peerManager";

const logger = {
  info: (..._args: any[]) => {},
  error: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
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
    const peers = Array.from(
      { length: 80 },
      (_, index) => `203.0.113.${index + 1}:18018`,
    );

    await peerManager.addKnownPeers(peers, "198.51.100.10:18018");

    const acceptedPeers = peerManager
      .getKnownPeers()
      .filter((peer) => peer.startsWith("203.0.113."));

    expect(acceptedPeers.length).toBe(32);
  });

  test("prunes stale peers with repeated failures and no success", async () => {
    const stalePeer = "198.51.100.77:18018";
    await peerManager.addKnownPeers([stalePeer], "198.51.100.10:18018");

    await peerManager.onDialFail(stalePeer);
    await peerManager.onDialFail(stalePeer);
    await peerManager.onDialFail(stalePeer);

    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const pruned = await peerManager.pruneStalePeers(Date.now() + threeDaysMs);

    expect(pruned).toBeGreaterThanOrEqual(1);
    expect(peerManager.getKnownPeers()).not.toContain(stalePeer);
  });

  test("does not prune peers with a successful outbound connection", async () => {
    const healthyPeer = "198.51.100.88:18018";
    await peerManager.addKnownPeers([healthyPeer], "198.51.100.10:18018");

    peerManager.registerOutboundConnection({
      id: healthyPeer,
      send: () => {},
    } as any);

    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    const beforePeers = new Set(peerManager.getKnownPeers());
    const pruned = await peerManager.pruneStalePeers(Date.now() + tenDaysMs);
    const afterPeers = new Set(peerManager.getKnownPeers());

    expect(afterPeers.has(healthyPeer)).toBe(true);
    expect(beforePeers.has(healthyPeer)).toBe(true);
    expect(afterPeers.size).toBe(beforePeers.size - pruned);
    expect(peerManager.getKnownPeers()).toContain(healthyPeer);
  });

  test("does not persist temporary peer penalties across reload", async () => {
    const badPeer = "198.51.100.99:18018";
    const flakyPeer = "198.51.100.100:18018";
    await peerManager.addKnownPeers(
      [badPeer, flakyPeer],
      "198.51.100.10:18018",
    );

    for (let i = 0; i < 10; i += 1) {
      await peerManager.reportInvalidPeer(badPeer, "bad data");
    }

    for (let i = 0; i < 6; i += 1) {
      await peerManager.onDialFail(flakyPeer);
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
    await peerManager.addKnownPeers([peer], "198.51.100.10:18018");

    await peerManager.onDialFail(peer);
    expect(peerManager.getOutboundCandidates()).not.toContain(peer);

    peerManager.registerOutboundConnection({
      id: peer,
      send: () => {},
    } as any);
    peerManager.unregisterConnection(peer);

    expect(peerManager.getOutboundCandidates()).toContain(peer);

    for (let i = 0; i < 10; i += 1) {
      await peerManager.reportInvalidPeer(peer, "bad data");
    }
    peerManager.registerOutboundConnection({
      id: peer,
      send: () => {},
    } as any);
    peerManager.unregisterConnection(peer);

    expect(peerManager.getOutboundCandidates()).not.toContain(peer);
  });

  test("does not create peer records for unknown invalid clients", async () => {
    const unknownPeer = "198.51.100.200:54321";

    await peerManager.reportInvalidPeer(unknownPeer, "bad data");

    expect(peerManager.getKnownPeers()).not.toContain(unknownPeer);
  });
});
