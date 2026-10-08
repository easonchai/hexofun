import { describe, expect, it } from "vitest";

import {
  ALREADY_GRANTED_MARKER,
  GRANT_RECLAIM_WINDOW_MS,
  reclaimUnlandedGrants,
  type GrantReclaimState,
} from "./grant-reclaim";

type Status = { err: unknown } | null;

function harness(status: Status) {
  const cleared: string[][] = [];
  const state: GrantReclaimState = { firstSeen: new Map(), confirmed: new Set() };
  const run = (now: number, rows = [{ referrer: "R", txSig: "sig" }], s: Status = status) =>
    reclaimUnlandedGrants({
      rows,
      connection: { getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(() => s) }) } as never,
      clear: async (referrers) => void cleared.push(referrers),
      state,
      now,
    });
  return { run, cleared };
}

describe("reclaimUnlandedGrants (mainnet-readiness-fixes 07)", () => {
  it("clears a signature the cluster does not know once the window has passed, not before", async () => {
    const { run, cleared } = harness(null);
    await run(1_000);
    await run(1_000 + GRANT_RECLAIM_WINDOW_MS - 1);
    expect(cleared).toEqual([]);
    await run(1_000 + GRANT_RECLAIM_WINDOW_MS);
    expect(cleared).toEqual([["R"]]);
  });

  it("keeps a confirmed signature, and does not ask about it again", async () => {
    const { run, cleared } = harness({ err: null });
    await run(0);
    await run(10 * GRANT_RECLAIM_WINDOW_MS, undefined, null);
    expect(cleared).toEqual([]);
  });

  it("clears a signature that landed with an error at once", async () => {
    const { run, cleared } = harness({ err: { InstructionError: [0, { Custom: 1 }] } });
    await run(0);
    expect(cleared).toEqual([["R"]]);
  });

  it("asks about more than 256 signatures in chunks, and drops across both", async () => {
    const calls: number[] = [];
    const cleared: string[][] = [];
    const rows = Array.from({ length: 300 }, (_, i) => ({ referrer: `R${i}`, txSig: `sig${i}` }));
    await reclaimUnlandedGrants({
      rows,
      connection: {
        getSignatureStatuses: async (sigs: string[]) => {
          calls.push(sigs.length);
          return { value: sigs.map(() => ({ err: { InstructionError: [0, { Custom: 1 }] } })) };
        },
      } as never,
      clear: async (referrers) => void cleared.push(referrers),
      state: { firstSeen: new Map(), confirmed: new Set() },
      now: 0,
    });
    expect(calls).toEqual([256, 44]);
    expect(cleared).toEqual([rows.map((row) => row.referrer)]);
  });

  it("ignores the already-granted marker", async () => {
    const { run, cleared } = harness(null);
    const rows = [{ referrer: "R", txSig: ALREADY_GRANTED_MARKER }];
    await run(0, rows);
    await run(10 * GRANT_RECLAIM_WINDOW_MS, rows);
    expect(cleared).toEqual([]);
  });
});
