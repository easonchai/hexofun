import { describe, expect, it } from "vitest";

import { snapshot } from "./useStatePoll.js";
import type { PlayerDto, StateDto } from "./api.js";

const player = (overrides: Partial<PlayerDto> = {}): PlayerDto => ({
  owner: "Ai1ce",
  principal: "1000000",
  tickets: "1000000",
  epochId: "7",
  isHouse: false,
  pendingWithdraw: "0",
  pendingEpoch: "0",
  pendingDeposit: "0",
  pendingDepositEpoch: "0",
  weight: "1000",
  pendingTickets: "0",
  pendingActivatesEpoch: null,
  odds: "50.00",
  ...overrides,
});

const state = (overrides: Partial<StateDto> = {}): StateDto =>
  ({
    pool: { totalPrincipal: "2000000" },
    currentEpoch: { jackpotAmount: "42069000000" },
    player: player(),
    status: { operator: { lastTickAt: "2026-09-14T00:00:00.000Z" } },
    chainTime: "1800000000",
    ...overrides,
    // SAFETY: snapshot only reads the fields above; the rest of the DTO would
    // be noise in a fixture that exists to say what counts as "changed".
  }) as unknown as StateDto;

describe("snapshot", () => {
  it("ignores what ticks on its own: chain time, the operator heartbeat, Weight and odds", () => {
    const before = state();
    const later = state({
      chainTime: "1800000012",
      status: { operator: { lastTickAt: "2026-09-14T00:00:12.000Z" } } as StateDto["status"],
      player: player({ weight: "13000", odds: "51.20" }),
    });
    expect(snapshot(later)).toBe(snapshot(before));
  });

  it("notices a deposit landing", () => {
    const deposited = state({ player: player({ principal: "3000000", tickets: "3000000" }) });
    expect(snapshot(deposited)).not.toBe(snapshot(state()));
  });

  it("notices a process_withdraw paying out, which moves nothing else", () => {
    // The pending amount is the only field that clears, so without it in the
    // snapshot the Vault's "confirming…" would never come down.
    const requested = state({ player: player({ pendingWithdraw: "500000", pendingEpoch: "7" }) });
    expect(snapshot(requested)).not.toBe(snapshot(state()));
  });

  it("notices Tickets moving on their own, as a bought-tickets credit does", () => {
    const credited = state({ player: player({ tickets: "2000000" }) });
    expect(snapshot(credited)).not.toBe(snapshot(state()));
  });
});
