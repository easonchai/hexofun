import { describe, expect, it } from "vitest";

import { formatAtomic2, parseAtomic } from "../lib/money.js";
import type { PositionLike } from "../engine.js";
import { stakeBarModel } from "./stakeBar.js";

const DECIMALS = 6;

const position = (overrides: Partial<PositionLike> = {}): PositionLike => ({
  tiles: 0n,
  stakePerTile: 1n,
  ...overrides,
});

/** The panel's own cost computation (ControlPanel.tsx): stake * tiles selected. */
const panelTotal = (stakeText: string, tileCount: number): bigint => {
  const stake = parseAtomic(stakeText, DECIMALS) ?? 0n;
  return stake * BigInt(Math.max(tileCount, 0));
};

describe("stakeBarModel — editing state", () => {
  it("shows zero tiles selected with a zero total", () => {
    const model = stakeBarModel("0.01", [], null, "mine", DECIMALS);
    expect(model.state).toBe("editing");
    expect(model.tilesSelected).toBe("0");
    expect(model.ticketsPerTile).toBe(formatAtomic2(parseAtomic("0.01", DECIMALS)!, DECIMALS));
    expect(model.ticketsIn).toBe(formatAtomic2(0n, DECIMALS));
    expect(model.label).toBe("DEPLOY");
  });

  it("shows one tile selected", () => {
    const model = stakeBarModel("0.5", [3], null, "mine", DECIMALS);
    expect(model.state).toBe("editing");
    expect(model.tilesSelected).toBe("1");
    expect(model.ticketsPerTile).toBe("0.50");
    expect(model.ticketsIn).toBe(formatAtomic2(panelTotal("0.5", 1), DECIMALS));
  });

  it("shows many tiles selected", () => {
    const tiles = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const model = stakeBarModel("2", tiles, null, "mine", DECIMALS);
    expect(model.state).toBe("editing");
    expect(model.tilesSelected).toBe("10");
    expect(model.ticketsIn).toBe(formatAtomic2(panelTotal("2", 10), DECIMALS));
  });

  it("matches the panel's existing cost computation exactly", () => {
    const stakeText = "1.234567";
    const tiles = [1, 2, 3, 4, 5];
    const model = stakeBarModel(stakeText, tiles, null, "mine", DECIMALS);
    expect(model.ticketsIn).toBe(
      formatAtomic2(panelTotal(stakeText, tiles.length), DECIMALS),
    );
  });

  it("treats idle the same as mine when no Position exists", () => {
    const model = stakeBarModel("1", [1, 2], null, "idle", DECIMALS);
    expect(model.state).toBe("editing");
  });
});

describe("stakeBarModel — placed state", () => {
  it("derives per-tile stake, tile count and total from the active Position", () => {
    const active = position({
      tiles: (1n << 0n) | (1n << 3n) | (1n << 35n),
      stakePerTile: 2_500_000n, // 2.5
    });
    const model = stakeBarModel("9", [], active, "mine", DECIMALS);
    expect(model.state).toBe("placed");
    expect(model.tilesSelected).toBe("3");
    expect(model.ticketsPerTile).toBe(formatAtomic2(2_500_000n, DECIMALS));
    expect(model.ticketsIn).toBe(formatAtomic2(7_500_000n, DECIMALS));
    expect(model.label).toBe("BET PLACED");
  });

  it("ignores the editing inputs once a Position is confirmed", () => {
    const active = position({ tiles: 1n, stakePerTile: 1_000_000n });
    const model = stakeBarModel("999", [1, 2, 3, 4], active, "mine", DECIMALS);
    expect(model.tilesSelected).toBe("1");
    expect(model.ticketsIn).toBe(formatAtomic2(1_000_000n, DECIMALS));
  });
});

describe("stakeBarModel — closed state (locked)", () => {
  it("shows the revealing copy once the Round is past its close", () => {
    const model = stakeBarModel("1", [1, 2], null, "locked", DECIMALS);
    expect(model.state).toBe("closed");
    expect(model.label).toBe("REVEALING…");
  });

  it("still surfaces the placed Position's figures once locked", () => {
    const active = position({ tiles: (1n << 1n) | (1n << 2n), stakePerTile: 4n });
    const model = stakeBarModel("1", [], active, "locked", DECIMALS);
    expect(model.state).toBe("closed");
    expect(model.tilesSelected).toBe("2");
    expect(model.label).toBe("REVEALING…");
  });
});
