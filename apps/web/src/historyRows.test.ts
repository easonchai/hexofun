import { describe, expect, it } from "vitest";

import type { EventDto } from "./api.js";
import { toHistoryRows } from "./historyRows.js";

const event = (name: string, data: Record<string, unknown>): EventDto => ({
  slot: "9",
  signature: "sig",
  index: 0,
  name,
  data,
  blockTime: "1700000000",
});

describe("toHistoryRows", () => {
  it("shows a request that refunded part and queued the rest as a Refund row and a requested row", () => {
    const rows = toHistoryRows(
      event("WithdrawRequested", {
        amount: "6000000000",
        refunded: "5301000000",
        paid: "5301000000",
        pending: "699000000",
      }),
    );
    expect(rows.map((row) => [row.label, row.amount])).toEqual([
      ["Refund", "- $5,301.00"],
      ["Withdraw requested", "$699.00"],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it("sizes the requested row from this request, not from the Player's whole queue", () => {
    const rows = toHistoryRows(
      event("WithdrawRequested", { amount: "500000000", refunded: "0", paid: "0", pending: "900000000" }),
    );
    expect(rows.map((row) => [row.label, row.amount])).toEqual([["Withdraw requested", "$500.00"]]);
  });

  it("shows the Refund row only when the whole request was refunded", () => {
    const rows = toHistoryRows(
      event("WithdrawRequested", { amount: "200000000", refunded: "200000000", paid: "200000000", pending: "0" }),
    );
    expect(rows.map((row) => [row.label, row.amount])).toEqual([["Refund", "- $200.00"]]);
  });

  it("shows a cancel with the cleared amount and no sign", () => {
    const rows = toHistoryRows(event("WithdrawCancelled", { amount: "699000000", pendingEpoch: "7" }));
    expect(rows.map((row) => [row.label, row.amount, row.prize])).toEqual([
      ["Withdraw cancelled", "$699.00", false],
    ]);
  });

  it("keeps deposits, withdrawals and prizes, and drops game events", () => {
    expect(toHistoryRows(event("Deposited", { amount: "1000000" }))[0]).toMatchObject({
      label: "Deposit",
      amount: "+ $1.00",
    });
    expect(toHistoryRows(event("Withdrawn", { amount: "1000000" }))[0]).toMatchObject({
      label: "Withdraw",
      amount: "- $1.00",
    });
    expect(toHistoryRows(event("JackpotPaid", { amount: "1000000" }))[0]).toMatchObject({
      label: "Prize Win",
      prize: true,
    });
    expect(toHistoryRows(event("PositionBought", { total: "5" }))).toEqual([]);
  });
});
