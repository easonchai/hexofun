import { describe, expect, it } from "vitest";

import {
  labelEpochStatus,
  labelRoundStatus,
  maskToTiles,
  popcount,
  TILE_COUNT,
  tileGridLabel,
  tilesToMask,
} from "./protocol.js";

describe("tile mask parsing", () => {
  it("parses '1,7,22' into a bitmask and back", () => {
    const mask = tilesToMask("1,7,22");
    expect(mask).toBe((1n << 1n) | (1n << 7n) | (1n << 22n));
    expect(maskToTiles(mask!)).toEqual([1, 7, 22]);
    expect(popcount(mask!)).toBe(3);
  });

  it("dedupes and tolerates whitespace", () => {
    expect(tilesToMask(" 5 , 5,9 ")).toBe((1n << 5n) | (1n << 9n));
    expect(maskToTiles(tilesToMask(" 5 , 5,9 ")!)).toEqual([5, 9]);
  });

  it("round-trips every tile on the 6x6 board", () => {
    expect(TILE_COUNT).toBe(36);
    const all = Array.from({ length: TILE_COUNT }, (_, tile) => tile);
    const text = all.join(",");
    expect(maskToTiles(tilesToMask(text)!)).toEqual(all);
    expect(popcount(tilesToMask(text)!)).toBe(36);
    expect(maskToTiles(0n)).toEqual([]);
    expect(tilesToMask("")).toBeNull();
  });

  it("rejects out-of-range and malformed input", () => {
    expect(tilesToMask("36")).toBeNull();
    expect(tilesToMask("-1")).toBeNull();
    expect(tilesToMask("1,")).toBeNull();
    expect(tilesToMask("1,x")).toBeNull();
    expect(tilesToMask("1.0")).toBeNull();
  });

  it("labels tiles by board coordinate", () => {
    expect(tileGridLabel(0)).toBe("row 1, col 1");
    expect(tileGridLabel(7)).toBe("row 2, col 2");
    expect(tileGridLabel(35)).toBe("row 6, col 6");
  });
});

describe("state labels", () => {
  it("names every epoch status", () => {
    expect(labelEpochStatus(0)).toBe("Open");
    expect(labelEpochStatus(1)).toBe("Ended");
    expect(labelEpochStatus(2)).toBe("Drawing");
    expect(labelEpochStatus(3)).toBe("Drawn");
    expect(labelEpochStatus(4)).toBe("Paid");
    expect(labelEpochStatus(5)).toBe("Rolled over");
    expect(labelEpochStatus(99)).toBe("unknown (99)");
  });

  it("names every round status", () => {
    expect(labelRoundStatus(0)).toBe("Open");
    expect(labelRoundStatus(1)).toBe("Requested");
    expect(labelRoundStatus(2)).toBe("Settled");
    expect(labelRoundStatus(3)).toBe("Forfeited");
    expect(labelRoundStatus(4)).toBe("Voided");
  });

  it("accepts the API's decimal strings and passes names through", () => {
    expect(labelRoundStatus("2")).toBe("Settled");
    expect(labelEpochStatus("1")).toBe("Ended");
    expect(labelEpochStatus("Ended")).toBe("Ended");
  });
});
