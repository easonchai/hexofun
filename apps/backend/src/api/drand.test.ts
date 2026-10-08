// The beacon fetch against recorded quicknet beacons and stub relays, no network
// (off-chain-tickets ticket 17).
import { createHash } from "node:crypto";

import type { ChainClient } from "drand-client";
import { describe, expect, it } from "vitest";

import { beaconRoundFor, beaconTime, fetchVerifiedBeacon, QUICKNET, relayClient } from "./drand";

// Recorded from api.drand.sh on 2026-10-08; Cloudflare served the same bytes.
const R70 = {
  round: 32883570,
  randomness: "73e596800483f975c7be834b098cf9f60080782b3bfdaaec8d86efaa3705c04b",
  signature:
    "a49c5c706f30491753d7c9542f6cb1bee6342dadcb360a497a73875b4884584618d6062fafbb0ce0a9f4a13f012b6b22",
};
const R71 = {
  round: 32883571,
  randomness: "944263303c38fa3b49e31ce207e6f45294d7fc5d046c01be6fc073cbdcc2050f",
  signature:
    "96f9e2ea99d65c72fa1c93faea757bfb89ce1598a9bfb99fe0ea7f1e9ea75274826443915e6966fdc3a98f333e728ea8",
};

/** A relay that answers every round with `answer`, or throws when `answer` is an Error. */
function stubRelay(name: string, answer: (round: number) => unknown): ChainClient {
  const chain = { baseUrl: name, info: async () => QUICKNET };
  return {
    options: { disableBeaconVerification: false, noCache: false },
    chain: () => chain,
    get: async (round: number) => answer(round) as never,
    latest: async () => {
      throw new Error("unused");
    },
  };
}

const randomnessOf = (signature: string): string => createHash("sha256").update(Buffer.from(signature, "hex")).digest("hex");

describe("beacon round", () => {
  it("is two rounds past the one already out at close", () => {
    // 1791454078 s is inside round 32883571 (research 03), so the reveal waits for 32883573.
    expect(beaconRoundFor(new Date(1791454078_000))).toBe(32883573);
    expect(beaconTime(32883573).getTime()).toBe((1692803367 + 32883572 * 3) * 1000);
  });
});

describe("fetchVerifiedBeacon", () => {
  it("returns a recorded beacon that verifies against the pinned key", async () => {
    const beacon = await fetchVerifiedBeacon([stubRelay("a", () => R70)], R70.round);
    expect(beacon).toEqual({ round: R70.round, signature: R70.signature });
  });

  it("skips a relay whose signature does not verify and takes the next one", async () => {
    const skipped: string[] = [];
    // Another round's valid signature relabelled as round 70, with matching randomness.
    const forged = { round: R70.round, signature: R71.signature, randomness: randomnessOf(R71.signature) };
    const beacon = await fetchVerifiedBeacon([stubRelay("bad", () => forged), stubRelay("good", () => R70)], R70.round, (relay) =>
      skipped.push(relay),
    );
    expect(beacon?.signature).toBe(R70.signature);
    expect(skipped).toEqual(["bad"]);
  });

  it("refuses a flipped signature, a mismatched randomness and an answer for another round", async () => {
    const flipped = R70.signature.slice(0, -1) + (R70.signature.endsWith("0") ? "1" : "0");
    const relays = [
      stubRelay("flipped", () => ({ round: R70.round, signature: flipped, randomness: randomnessOf(flipped) })),
      stubRelay("randomness", () => ({ ...R70, randomness: R71.randomness })),
      stubRelay("round", () => R71),
    ];
    const skipped: string[] = [];
    expect(await fetchVerifiedBeacon(relays, R70.round, (relay) => skipped.push(relay))).toBeNull();
    expect(skipped).toEqual(["flipped", "randomness", "round"]);
  });

  it("skips a relay that errors", async () => {
    const down = stubRelay("down", () => {
      throw new Error("relay answered 503");
    });
    expect((await fetchVerifiedBeacon([down, stubRelay("up", () => R70)], R70.round))?.round).toBe(R70.round);
  });
});

describe("relayClient", () => {
  it("gives up on a relay that does not answer within the timeout", async () => {
    const { createServer } = await import("node:http");
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const client = relayClient(`http://127.0.0.1:${port}`, 100);
      await expect(client.get(R70.round)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
