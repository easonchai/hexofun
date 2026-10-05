import { describe, expect, it } from "vitest";

import { decodeErrorCode, decodeSendFailure, thrownCode } from "./playerErrors.js";
import {
  afterHaircut,
  effectiveTickets,
  INSUFFICIENT_TICKETS_CODE,
  instantLimit,
  offersQueue,
  planWithdraw,
  VENUE_ILLIQUID_CODE,
  VENUE_SHORT_RETURN_CODE,
  type PlanInput,
} from "./instantWithdraw.js";

const USDC = 1_000_000n;
const base: PlanInput = {
  amount: 100n * USDC,
  principal: 500n * USDC,
  tickets: 500n * USDC,
  coverable: true,
  haircutFactor: null,
  forceQueue: false,
};

describe("planWithdraw", () => {
  it("is instant when the pool covers it and Tickets allow it", () => {
    const plan = planWithdraw(base);
    expect(plan).toMatchObject({ kind: "instant", reason: null, receive: 100n * USDC, haircut: 0n });
    expect(plan.ticketsAfter).toBe(400n * USDC);
  });

  it("is instant while the cover answer is unknown; the simulation catches a refusal", () => {
    expect(planWithdraw({ ...base, coverable: null }).kind).toBe("instant");
  });

  it("queues when the pool cannot cover it", () => {
    expect(planWithdraw({ ...base, coverable: false })).toMatchObject({
      kind: "queued",
      reason: "pool-short",
    });
  });

  it("queues past min(Principal, Tickets), even when the pool could cover it", () => {
    const plan = planWithdraw({ ...base, tickets: 40n * USDC });
    expect(plan).toMatchObject({ kind: "queued", reason: "over-limit" });
    // A request removes at most the Tickets held.
    expect(plan.ticketsAfter).toBe(0n);
  });

  it("stays queued after the instant transaction failed illiquid", () => {
    expect(planWithdraw({ ...base, forceQueue: true })).toMatchObject({
      kind: "queued",
      reason: "venue-illiquid",
    });
  });

  it("shows the haircut amount while impaired, instant or queued", () => {
    const instant = planWithdraw({ ...base, haircutFactor: 0.82 });
    expect(instant).toMatchObject({ kind: "instant", receive: 82n * USDC, haircut: 18n * USDC });
    const queued = planWithdraw({ ...base, coverable: false, haircutFactor: 0.82 });
    expect(queued).toMatchObject({ kind: "queued", receive: 82n * USDC });
  });
});

describe("Tickets rule", () => {
  it("limits an instant withdrawal to the smaller of Principal and Tickets", () => {
    expect(instantLimit(500n, 400n)).toBe(400n);
    expect(instantLimit(400n, 500n)).toBe(400n);
  });

  it("reads Tickets as Principal once the Player's epoch is stale", () => {
    expect(effectiveTickets(500n, 100n, 3n, 4n)).toBe(500n);
    expect(effectiveTickets(500n, 100n, 4n, 4n)).toBe(100n);
    expect(effectiveTickets(500n, 100n, 4n, null)).toBe(100n);
  });
});

describe("afterHaircut", () => {
  it("floors, and leaves an unimpaired amount alone", () => {
    expect(afterHaircut(10n, null)).toBe(10n);
    expect(afterHaircut(10n, 1)).toBe(10n);
    expect(afterHaircut(10n, 0.333333)).toBe(3n);
    expect(afterHaircut(10n, -1)).toBe(0n);
  });
});

describe("instant withdraw error copy", () => {
  it("offers the queue for the refusals it avoids, and no others", () => {
    expect(offersQueue(VENUE_ILLIQUID_CODE)).toBe(true);
    expect(offersQueue(VENUE_SHORT_RETURN_CODE)).toBe(true);
    expect(offersQueue(INSUFFICIENT_TICKETS_CODE)).toBe(true);
    expect(offersQueue(6003)).toBe(false);
    expect(offersQueue(null)).toBe(false);
  });

  it("maps VenueIlliquid to friendly copy that names the queue, with no raw error", () => {
    const text = decodeSendFailure({
      kind: "failed",
      code: VENUE_ILLIQUID_CODE,
      message: '{"InstructionError":[2,{"Custom":6063}]}',
    });
    expect(text).toMatch(/Queue it/);
    expect(text).not.toMatch(/6063|Custom|VenueIlliquid/);
  });

  it("explains InsufficientTickets in the form's words", () => {
    expect(decodeErrorCode(INSUFFICIENT_TICKETS_CODE)).toMatch(/daily reset/);
  });

  it("reads the code out of a send-time refusal", () => {
    const error = new Error("AnchorError. Error Code: VenueIlliquid. Error Number: 6063. Error Message: x");
    expect(thrownCode(error)).toBe(VENUE_ILLIQUID_CODE);
    expect(thrownCode(new Error("User rejected the request"))).toBeNull();
  });
});
