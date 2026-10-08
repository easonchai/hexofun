// The Ticket ledger's per-wallet rules (off-chain-tickets 11, ADR 0025). Pure:
// no Prisma. The store (`ledger-store.ts`) feeds it chain events in chain order
// and writes what it returns. `EpochBegan` is not here: it touches every
// wallet at once, so the store does it set-based.
import type { TicketReason } from "@prisma/client";

import type { DecodedEvent } from "../indexer/decode";

export interface BalanceState {
  tickets: bigint;
  principal: bigint;
  yieldIndex: bigint;
}

export interface Booking {
  next: BalanceState;
  /** The ledger row this event adds; null when it only moves Principal. */
  row: { delta: bigint; reason: TicketReason } | null;
}

const EMPTY: BalanceState = { tickets: 0n, principal: 0n, yieldIndex: 0n };

/** `jsonify` renders every pubkey and u64 or u128 as a string. */
export function eventString(event: DecodedEvent, key: string): string {
  const { data } = event;
  const value = typeof data === "object" && data !== null && !Array.isArray(data) ? data[key] : undefined;
  if (typeof value !== "string") throw new Error(`${event.name} event has no string field ${key}`);
  return value;
}

/** The wallet an event is about, or null for an event the ledger ignores. */
export function walletOf(event: DecodedEvent): string | null {
  switch (event.name) {
    case "Deposited":
    case "WithdrawRequested":
    case "WithdrawCancelled":
    case "TicketsBought":
    case "EmergencyWithdrawn":
    case "Withdrawn":
      return eventString(event, "owner");
    case "JackpotPaid":
      return eventString(event, "winner");
    default:
      return null;
  }
}

const isHouseWin = (event: DecodedEvent): boolean =>
  typeof event.data === "object" && event.data !== null && !Array.isArray(event.data) && event.data.isHouse === true;

/**
 * What one chain event does to its wallet's balance, or null for an event the
 * ledger ignores. `previous` is the balance before the event, undefined for a
 * wallet the ledger has not seen.
 *
 * Every event that runs `touch` on chain carries the Player's Principal and the
 * Yield index after the instruction, so the balance sets them rather than
 * adding to them. Tickets move on `Withdrawn`, `JackpotPaid` and
 * `TicketsBought`, the last at `ticketsPerUsdc`, the Game config rate in force
 * at the event's block time, which the caller looks up.
 */
export function bookEvent(previous: BalanceState | undefined, event: DecodedEvent, ticketsPerUsdc?: number): Booking | null {
  if (walletOf(event) === null) return null;
  const before = previous ?? EMPTY;
  const next: BalanceState = {
    ...before,
    principal: BigInt(eventString(event, "principal")),
    yieldIndex: BigInt(eventString(event, "yieldIndex")),
  };
  if (event.name === "Withdrawn") {
    // As `process_withdraw` did on chain: Tickets fall by the amount paid, never below zero.
    const paid = BigInt(eventString(event, "amount"));
    const delta = -(paid < before.tickets ? paid : before.tickets);
    return { next: { ...next, tickets: before.tickets + delta }, row: delta === 0n ? null : { delta, reason: "withdraw" } };
  }
  if (event.name === "JackpotPaid" && !isHouseWin(event)) {
    // The House's share is USDC and books nothing; the winner's prize compounds into Principal.
    const prize = BigInt(eventString(event, "amount"));
    return { next: { ...next, tickets: before.tickets + prize }, row: prize === 0n ? null : { delta: prize, reason: "prize" } };
  }
  if (event.name === "TicketsBought") {
    if (ticketsPerUsdc === undefined) throw new Error("TicketsBought needs the Game config's ticketsPerUsdc");
    const bought = BigInt(eventString(event, "usdc")) * BigInt(ticketsPerUsdc);
    return { next: { ...next, tickets: before.tickets + bought }, row: bought === 0n ? null : { delta: bought, reason: "buy" } };
  }
  return { next, row: null };
}
