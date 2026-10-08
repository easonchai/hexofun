// The drand quicknet beacon a Round reveals from (off-chain-tickets ticket 17,
// research 03). Chain hash, public key, period and genesis are pinned here, so
// a relay never gets to describe the chain it serves: `drand-client` verifies
// each beacon's BLS signature against the pinned key and a relay that lies, or
// that serves another chain, fails verification and the next relay is tried.
import { type Chain, type ChainClient, type ChainInfo, fetchBeacon, roundAt, roundTime } from "drand-client";

/** Quicknet: unchained, 3 s period, signatures on G1 (RFC 9380). Matches research 03 and the live `/info`. */
export const QUICKNET: ChainInfo = {
  hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  public_key:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  period: 3,
  genesis_time: 1692803367,
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: "bls-unchained-g1-rfc9380",
  metadata: { beaconID: "quicknet" },
};

/** Tried in this order for every Round. */
export const DRAND_RELAYS: readonly string[] = ["https://api.drand.sh", "https://drand.cloudflare.com"];

/** One relay request gives up after this long and the next relay is tried. */
export const RELAY_TIMEOUT_MS = 5_000;

/** A Round is voided when its beacon is still missing this long after the beacon's emission time. */
export const VOID_AFTER_MS = 10 * 60 * 1000;

/** The first round released after `closeAt` is `+1`; the extra one absorbs clock skew (research 03). */
export const BEACON_ROUND_GUARD = 2;

/** The quicknet round a Round closing at `closeAt` reveals from. */
export function beaconRoundFor(closeAt: Date): number {
  return roundAt(closeAt.getTime(), QUICKNET) + BEACON_ROUND_GUARD;
}

/** When quicknet emits `round`, as a Date. */
export function beaconTime(round: number): Date {
  return new Date(roundTime(QUICKNET, round));
}

/** A relay speaking drand's HTTP API for the pinned chain only. */
export function relayClient(relayUrl: string, timeoutMs: number = RELAY_TIMEOUT_MS): ChainClient {
  const baseUrl = `${relayUrl}/${QUICKNET.hash}`;
  const chain: Chain = { baseUrl, info: async () => QUICKNET };
  const options = { disableBeaconVerification: false, noCache: false };
  return {
    options,
    chain: () => chain,
    async get(round: number) {
      const response = await fetch(`${baseUrl}/public/${round}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`relay answered ${response.status} for round ${round}`);
      return response.json();
    },
    async latest() {
      throw new Error("latest is not used");
    },
  };
}

export const defaultRelays = (): ChainClient[] => DRAND_RELAYS.map((url) => relayClient(url));

export interface VerifiedBeacon {
  round: number;
  /** Hex of the 48-byte BLS signature. */
  signature: string;
}

/**
 * Asks each relay in turn for `round` and returns the first answer whose
 * signature verifies against the pinned key. A relay that errors, times out or
 * answers with a bad signature is skipped; `null` means none gave a good beacon.
 */
export async function fetchVerifiedBeacon(
  relays: readonly ChainClient[],
  round: number,
  onSkip: (relay: string, cause: unknown) => void = () => {},
): Promise<VerifiedBeacon | null> {
  for (const relay of relays) {
    try {
      const beacon = await fetchBeacon(relay, round);
      return { round: beacon.round, signature: beacon.signature };
    } catch (cause) {
      onSkip(relay.chain().baseUrl, cause);
    }
  }
  return null;
}
