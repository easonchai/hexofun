import { describe, expect, it } from "vitest";

import {
  addCapped,
  clampDecimals,
  depositOpen,
  formatAddress,
  formatAtomic,
  formatAtomic2,
  formatMoney2,
  haircutValue,
  parseAtomic,
  pendingTickets,
  pendingWithdrawal,
  splitWithdraw,
} from "./money.js";

describe("vault widget math", () => {
  it("typed amounts stop at two decimals", () => {
    expect(clampDecimals("12.3456", 2)).toBe("12.34");
    expect(clampDecimals("1.2.3", 2)).toBe("1.23");
    expect(clampDecimals("500", 2)).toBe("500");
    expect(clampDecimals("5.", 2)).toBe("5.");
    expect(clampDecimals("abc", 2)).toBe("");
  });

  it("quick pills add and stop at the cap", () => {
    expect(addCapped(20n, 50n, 100n)).toBe(70n);
    expect(addCapped(80n, 50n, 100n)).toBe(100n);
    expect(addCapped(80n, 50n, null)).toBe(130n);
  });
});

describe("atomic formatting", () => {
  it("renders atomic units with pool decimals and never uses floats", () => {
    expect(formatAtomic(1_000_000n, 6)).toBe("1.000000");
    expect(formatAtomic(1_500_000n, 6)).toBe("1.500000");
    expect(formatAtomic(1n, 6)).toBe("0.000001");
    expect(formatAtomic(0n, 6)).toBe("0.000000");
    expect(formatAtomic(123n, 0)).toBe("123");
    expect(formatAtomic(-2_500_000n, 6)).toBe("-2.500000");
  });

  it("truncates to two decimals for display, never rounding", () => {
    expect(formatAtomic2(1_999_970_000n, 6)).toBe("1999.97");
    expect(formatAtomic2(15_000n, 6)).toBe("0.01");
    expect(formatAtomic2(0n, 6)).toBe("0.00");
    expect(formatAtomic2(-1_999_970_000n, 6)).toBe("-1999.97");
  });

  it("groups thousands for display", () => {
    expect(formatMoney2(42_759_280_000n, 6)).toBe("42,759.28");
    expect(formatMoney2(1_000_000_000n, 6)).toBe("1,000.00");
    expect(formatMoney2(999_990_000n, 6)).toBe("999.99");
    expect(formatMoney2(-1_234_567_000_000n, 6)).toBe("-1,234,567.00");
  });

  it("parses decimal text into atomic units exactly", () => {
    expect(parseAtomic("1.5", 6)).toBe(1_500_000n);
    expect(parseAtomic("12", 6)).toBe(12_000_000n);
    expect(parseAtomic(" 0.000001 ", 6)).toBe(1n);
    expect(parseAtomic("1.0000001", 6)).toBeNull();
    expect(parseAtomic("abc", 6)).toBeNull();
    expect(parseAtomic("-1", 6)).toBeNull();
    expect(parseAtomic("1.2.3", 6)).toBeNull();
    expect(parseAtomic("", 6)).toBeNull();
  });

  it("round-trips atomic -> text -> atomic", () => {
    for (const value of [0n, 1n, 999n, 1_000_000n, 123456789n]) {
      expect(parseAtomic(formatAtomic(value, 6), 6)).toBe(value);
    }
  });
});

describe("withdrawal math", () => {
  it("keeps addresses short for display", () => {
    expect(formatAddress("6aDFSdwXESHF7UXJRCkHogNtUTbDPajmLupsfvzTSGvB")).toBe(
      "6aDF…SGvB",
    );
    expect(formatAddress("short")).toBe("short");
  });
});

describe("pending withdrawal row", () => {
  it("is none while nothing has been requested", () => {
    expect(pendingWithdrawal(0n, 0n, 7n, false, false)).toEqual({ kind: "none" });
    // A sent payout with nothing pending is still nothing pending.
    expect(pendingWithdrawal(0n, 6n, 7n, true, false)).toEqual({ kind: "none" });
  });

  it("is pending inside the epoch it was requested in", () => {
    expect(pendingWithdrawal(5_000_000n, 7n, 7n, false, false)).toEqual({
      kind: "pending",
      amount: 5_000_000n,
      epoch: 7n,
    });
  });

  it("is due once that epoch has ended", () => {
    expect(pendingWithdrawal(5_000_000n, 7n, 8n, false, false)).toEqual({
      kind: "due",
      amount: 5_000_000n,
      epoch: 7n,
    });
  });

  it("is processing while the payout transaction is out", () => {
    expect(pendingWithdrawal(5_000_000n, 7n, 8n, true, false)).toEqual({
      kind: "processing",
      amount: 5_000_000n,
      epoch: 7n,
    });
  });

  it("stays pending when the current epoch is unknown", () => {
    // Backend unreachable: offering "pay out now" would only earn a
    // WithdrawalNotDue from the program.
    expect(pendingWithdrawal(5_000_000n, 7n, null, false, false).kind).toBe("pending");
  });

  it("is due immediately once the pool is shut down, even mid-epoch", () => {
    expect(pendingWithdrawal(5_000_000n, 7n, 7n, false, true)).toEqual({
      kind: "due",
      amount: 5_000_000n,
      epoch: 7n,
    });
    // And even with no epoch known at all.
    expect(pendingWithdrawal(5_000_000n, 7n, null, false, true).kind).toBe("due");
  });

  it("still shows processing over due while a shutdown payout is in flight", () => {
    expect(pendingWithdrawal(5_000_000n, 7n, 7n, true, true)).toEqual({
      kind: "processing",
      amount: 5_000_000n,
      epoch: 7n,
    });
  });
});

// ADR 0020: a deposit earns Tickets from the next epoch. 500 of Principal, 400
// of it deposited in epoch 4, so 100 Tickets are active in epoch 4.
describe("tickets and the pending deposit", () => {
  it("holds the deposit pending and out of Tickets in the epoch it was made", () => {
    expect(pendingTickets(400n, 4n, 4n)).toBe(400n);
  });

  it("folds the deposit into Tickets from the next epoch, with no transaction", () => {
    expect(pendingTickets(400n, 4n, 5n)).toBe(0n);
  });

  it("reads the row as it is while the epoch is unknown", () => {
    expect(pendingTickets(400n, 4n, null)).toBe(400n);
  });
});

// ADR 0020: the pending deposit refunds now, the rest queues. 400 of Principal
// is pending in these cases.
describe("splitWithdraw", () => {
  it("pays an amount inside the pending deposit now and queues nothing", () => {
    expect(splitWithdraw(250n, 400n)).toEqual({ payNow: 250n, queued: 0n });
    expect(splitWithdraw(400n, 400n)).toEqual({ payNow: 400n, queued: 0n });
  });

  it("queues the whole amount when no deposit is pending", () => {
    expect(splitWithdraw(250n, 0n)).toEqual({ payNow: 0n, queued: 250n });
  });

  it("pays the pending part now and queues the rest", () => {
    expect(splitWithdraw(700n, 400n)).toEqual({ payNow: 400n, queued: 300n });
  });
});

describe("depositOpen", () => {
  it("closes the deposit form while the pool is paused or impaired", () => {
    expect(depositOpen(false, false)).toBe(true);
    expect(depositOpen(true, false)).toBe(false);
    expect(depositOpen(false, true)).toBe(false);
  });
});

describe("haircutValue", () => {
  it("pays the whole amount when the pool is whole", () => {
    expect(haircutValue(500n, null)).toBe(500n);
    expect(haircutValue(500n, 1)).toBe(500n);
  });

  it("pays the haircut share, rounded down", () => {
    expect(haircutValue(500_000_000n, 0.82)).toBe(410_000_000n);
    expect(haircutValue(100n, 0.333333)).toBe(33n);
    expect(haircutValue(500n, 0)).toBe(0n);
  });
});
