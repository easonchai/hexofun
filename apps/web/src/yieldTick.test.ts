import { describe, expect, it } from "vitest";

import type { LiveYieldDto } from "./api.js";
import { rateCopy } from "./yieldTick.js";

describe("rateCopy", () => {
  const live = (aprBps: number | null, shortHistory = false): LiveYieldDto => ({
    rates: {
      trailing24h: { aprBps, windowSeconds: 86_400, shortHistory },
      trailing7d: { aprBps, windowSeconds: 604_800, shortHistory },
      estimatedBps: 400,
      ceilingBps: 500,
    },
    yieldFeeBps: 1_000,
    buyTicketsPaused: false,
    freeIdle: null,
    haircutFactor: null,
  });

  it("reads up to the ceiling with the 7-day paid rate", () => {
    expect(rateCopy(live(412.4))).toEqual({ ceiling: "up to 5.00%", trailing: "4.12%", trailingShort: false });
  });

  it("shows a dash before there is history", () => {
    expect(rateCopy(live(null, true))).toEqual({ ceiling: "up to 5.00%", trailing: "—", trailingShort: true });
  });
});
