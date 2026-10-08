import { describe, expect, it } from "vitest";

import type { DecodedEvent } from "../indexer/decode";
import { bookEvent, walletOf, type BalanceState } from "./ticket-ledger";

const OWNER = "OwnerWallet111";
const held = (tickets: bigint, principal = 0n): BalanceState => ({ tickets, principal, yieldIndex: 0n });
const event = (name: string, data: Record<string, string | boolean>): DecodedEvent => ({ name, data });
const moved = { principal: "700", yieldIndex: "1000000000000000000" };

describe("bookEvent", () => {
  it.each(["Deposited", "WithdrawRequested", "WithdrawCancelled", "EmergencyWithdrawn"])(
    "%s sets Principal and the Yield index and books no Tickets",
    (name) => {
      const booking = bookEvent(held(40n, 100n), event(name, { owner: OWNER, ...moved }));
      expect(booking).toEqual({ next: { tickets: 40n, principal: 700n, yieldIndex: 10n ** 18n }, row: null });
    },
  );

  it("TicketsBought books usdc times the rate it is given as a buy row", () => {
    const bought = event("TicketsBought", { owner: OWNER, usdc: "250", ...moved });
    expect(bookEvent(held(40n, 100n), bought, 10)).toEqual({
      next: { tickets: 2_540n, principal: 700n, yieldIndex: 10n ** 18n },
      row: { delta: 2_500n, reason: "buy" },
    });
    // The same event at another rate: the rate is an input, never remembered.
    expect(bookEvent(held(40n), bought, 4)).toMatchObject({ row: { delta: 1_000n, reason: "buy" } });
    expect(() => bookEvent(held(0n), bought)).toThrow(/ticketsPerUsdc/);
  });

  it("starts an unseen wallet at zero Tickets", () => {
    expect(bookEvent(undefined, event("Deposited", { owner: OWNER, ...moved }))?.next.tickets).toBe(0n);
  });

  it("Withdrawn takes the amount paid from the Tickets", () => {
    const booking = bookEvent(held(500n), event("Withdrawn", { owner: OWNER, amount: "200", ...moved }));
    expect(booking).toEqual({
      next: { tickets: 300n, principal: 700n, yieldIndex: 10n ** 18n },
      row: { delta: -200n, reason: "withdraw" },
    });
  });

  it("Withdrawn floors the Tickets at zero and writes a row only for what it took", () => {
    const over = bookEvent(held(150n), event("Withdrawn", { owner: OWNER, amount: "900", ...moved }));
    expect(over).toMatchObject({ next: { tickets: 0n }, row: { delta: -150n, reason: "withdraw" } });
    const none = bookEvent(held(0n), event("Withdrawn", { owner: OWNER, amount: "900", ...moved }));
    expect(none).toMatchObject({ next: { tickets: 0n }, row: null });
  });

  it("JackpotPaid books the prize to a non-House winner as a prize row", () => {
    const paid = event("JackpotPaid", { winner: OWNER, amount: "1000", isHouse: false, ...moved });
    expect(bookEvent(held(5n), paid)).toEqual({
      next: { tickets: 1_005n, principal: 700n, yieldIndex: 10n ** 18n },
      row: { delta: 1_000n, reason: "prize" },
    });
  });

  it("JackpotPaid to the House books nothing", () => {
    const paid = event("JackpotPaid", { winner: OWNER, amount: "1000", isHouse: true, principal: "0", yieldIndex: "0" });
    expect(bookEvent(held(0n), paid)).toEqual({ next: { tickets: 0n, principal: 0n, yieldIndex: 0n }, row: null });
  });

  it("ignores events that are not about a wallet's balance", () => {
    expect(bookEvent(undefined, event("EpochDrawn", { epochId: "1" }))).toBeNull();
    expect(walletOf(event("EpochBegan", { epochId: "2" }))).toBeNull();
  });

  it("refuses an event that lacks the post-state fields", () => {
    expect(() => bookEvent(undefined, event("Deposited", { owner: OWNER, principal: "1" }))).toThrow(/yieldIndex/);
  });
});
