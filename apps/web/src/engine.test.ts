import { describe, expect, it } from "vitest";

import type { LastRoundDto, OpenRoundDto } from "./api.js";
import {
  boardResult,
  covers,
  decideAutoRound,
  decideReveal,
  dhmsParts,
  displayTile,
  hmText,
  idleBoardLabel,
  longestRoundSeconds,
  openRoundFrom,
  phaseFor,
  positionsFrom,
  potOf,
  resultRoundFrom,
  roundKey,
  secondsLeft,
  tileCountOf,
  tilesOfMask,
  timerText,
  type OpenRound,
  type Phase,
  type RememberedBoard,
  type ResultRound,
} from "./engine.js";

// 12:00:00 UTC on a minute mark, as unix seconds.
const NOON = BigInt(Date.parse("2026-10-08T12:00:00Z") / 1000);

const open = (overrides: Partial<OpenRound> = {}): OpenRound => ({
  roundId: 4n,
  closeAt: NOON + 120n,
  tileTotals: Array<bigint>(36).fill(0n),
  ...overrides,
});

const result = (overrides: Partial<ResultRound> = {}): ResultRound => ({
  roundId: 3n,
  status: "closed",
  tile: null,
  ...overrides,
});

describe("round engine", () => {
  it("keys a round by its pool-wide round id", () => {
    expect(roundKey(7n)).toBe("7");
  });

  it("derives the betting phase from the open Round and the server clock", () => {
    expect(phaseFor(null, NOON)).toBe("idle");
    expect(phaseFor(open(), NOON)).toBe("mine");
    expect(phaseFor(open(), NOON + 119n)).toBe("mine");
    // From closeAt itself betting is shut, until the server closes the Round.
    expect(phaseFor(open(), NOON + 120n)).toBe("locked");
    expect(phaseFor(open(), NOON + 500n)).toBe("locked");
  });

  it("counts seconds left down to closeAt through mine, zero elsewhere", () => {
    expect(secondsLeft(open(), NOON + 20n)).toBe(100n);
    expect(secondsLeft(open(), NOON + 119n)).toBe(1n);
    expect(secondsLeft(open(), NOON + 120n)).toBe(0n);
    expect(secondsLeft(null, NOON)).toBe(0n);
  });

  it("adds up the open Round's tiles as its pot", () => {
    expect(potOf(null)).toBe(0n);
    expect(potOf(open({ tileTotals: Array.from({ length: 36 }, (_, tile) => (tile === 3 || tile === 7 ? 10n : 0n)) }))).toBe(20n);
  });

  it("renders the timer and display tile numbers", () => {
    expect(timerText(65n)).toBe("01:05");
    expect(timerText(5n)).toBe("00:05");
    expect(timerText(0n)).toBe("00:00");
    expect(displayTile(0)).toBe(1);
    expect(displayTile(35)).toBe(36);
  });

  it("renders HH:MM for epoch-length countdowns", () => {
    expect(hmText(0n)).toBe("00:00");
    expect(hmText(59n)).toBe("00:00");
    expect(hmText(60n)).toBe("00:01");
    expect(hmText(3600n)).toBe("01:00");
    expect(hmText(90_000n)).toBe("25:00");
    // Already past: clamp, no sign.
    expect(hmText(-5n)).toBe("00:00");
  });

  it("splits a weekly countdown into DD HH MM SS", () => {
    // 3d 23h 48m 18s, the Figma landing's sample clock.
    expect(dhmsParts(3n * 86400n + 23n * 3600n + 48n * 60n + 18n)).toEqual([
      "03",
      "23",
      "48",
      "18",
    ]);
    expect(dhmsParts(0n)).toEqual(["00", "00", "00", "00"]);
    expect(dhmsParts(-1n)).toEqual(["00", "00", "00", "00"]);
  });

  it("reads tiles out of a mask in the order the bet text lists them", () => {
    const mask = (1n << 12n) | (1n << 3n) | (1n << 35n);
    expect(tilesOfMask(mask)).toEqual([3, 12, 35]);
    expect(tileCountOf(mask)).toBe(3);
    expect(covers(mask, 12)).toBe(true);
    expect(covers(mask, 13)).toBe(false);
  });
});

describe("API Rounds to engine Rounds", () => {
  const openDto: OpenRoundDto = {
    id: "4",
    openAt: "2026-10-08T12:00:10.000Z",
    closeAt: "2026-10-08T12:02:00.000Z",
    status: "open",
    tileTotals: Array.from({ length: 36 }, (_, tile) => (tile === 3 ? "10" : "0")),
    seedCommitment: "c".repeat(64),
  };

  it("reads closeAt as unix seconds and the totals as bigints", () => {
    const round = openRoundFrom(openDto)!;
    expect(round.roundId).toBe(4n);
    expect(round.closeAt).toBe(NOON + 120n);
    expect(round.tileTotals[3]).toBe(10n);
  });

  it("has no open Round for null, and never treats a closed one as open", () => {
    expect(openRoundFrom(null)).toBeNull();
    expect(openRoundFrom({ ...openDto, status: "closed" })).toBeNull();
  });

  it("maps the newest finished Round and refuses an open one", () => {
    const dto: LastRoundDto = { id: "3", status: "settled", tile: 17, seedCommitment: "d".repeat(64) };
    expect(resultRoundFrom(dto)).toEqual({ roundId: 3n, status: "settled", tile: 17 });
    expect(resultRoundFrom(null)).toBeNull();
    expect(resultRoundFrom({ ...dto, status: "open" })).toBeNull();
  });

  it("keys the wallet's Positions by Round id", () => {
    const positions = positionsFrom([{ roundId: "3", tiles: "136", stakePerTile: "1000000" }]);
    expect(positions.get("3")).toEqual({ tiles: 136n, stakePerTile: 1_000_000n });
    expect(positions.get("4")).toBeUndefined();
  });
});

describe("boardResult: what the board says beside the countdown", () => {
  it("says nothing on an idle board with no finished Round", () => {
    expect(boardResult("idle", null, null)).toBeNull();
  });

  it("shows DRAWING while a closed or revealed Round waits on its tile", () => {
    expect(boardResult("idle", null, result({ status: "closed" }))).toBe("DRAWING");
    expect(boardResult("idle", null, result({ status: "revealed" }))).toBe("DRAWING");
  });

  it("shows DRAWING for the open Round once its close has passed", () => {
    expect(boardResult("locked", open(), null)).toBe("DRAWING");
  });

  // The engine keeps the next Round open, so /state right after a close has both.
  const boardWith = (last: ResultRound) => {
    const next = open({ roundId: 4n });
    const phase = phaseFor(next, NOON + 10n, last);
    return { phase, result: boardResult(phase, next, last) };
  };

  it("shows DRAWING beside a next open Round while the closed one waits on its tile", () => {
    expect(boardWith(result({ status: "closed" }))).toEqual({ phase: "locked", result: "DRAWING" });
  });

  it("brings the next Round's countdown back once the tile has landed", () => {
    expect(boardWith(result({ status: "revealed", tile: 5 }))).toEqual({ phase: "mine", result: null });
  });

  it("shows nothing and keeps the countdown when the closed Round voided", () => {
    expect(boardWith(result({ status: "voided" }))).toEqual({ phase: "mine", result: null });
  });

  it("shows nothing for a voided or a settled Round", () => {
    expect(boardResult("idle", null, result({ status: "voided" }))).toBeNull();
    expect(boardResult("idle", null, result({ status: "settled", tile: 5 }))).toBeNull();
  });
});

describe("decideAutoRound", () => {
  const board: RememberedBoard = { tiles: [1, 2, 3], stake: 10n };

  it.each([
    ["no remembered board", null, 1000n, "mine" as Phase, false, "no remembered board"],
    ["empty tiles", { tiles: [], stake: 10n }, 1000n, "mine" as Phase, false, "remembered board has no tiles"],
    ["zero stake", { tiles: [1, 2], stake: 0n }, 1000n, "mine" as Phase, false, "remembered stake is zero"],
    ["stake exceeding Tickets", board, 5n, "mine" as Phase, false, "stake exceeds Tickets"],
    ["Position already placed", board, 1000n, "mine" as Phase, true, "position already placed this round"],
    ["phase locked", board, 1000n, "locked" as Phase, false, "round is not open for positions"],
  ])("%s → skip", (_label, remembered, tickets, phase, hasPosition, reason) => {
    expect(decideAutoRound(remembered as RememberedBoard | null, tickets, phase, hasPosition)).toEqual({
      action: "skip",
      reason,
    });
  });

  it("places the remembered board into an open Round or an empty board", () => {
    for (const phase of ["mine", "idle"] as const) {
      expect(decideAutoRound(board, 1000n, phase, false)).toEqual({
        action: "place",
        tiles: board.tiles,
        stake: board.stake,
      });
    }
  });
});

describe("decideReveal", () => {
  const remembered = result({ roundId: 3n, status: "settled", tile: 5 });
  const noPlayed: ReadonlySet<string> = new Set();

  it("waits with no remembered result yet", () => {
    expect(decideReveal(null, noPlayed)).toBe("wait");
  });

  it("fires as soon as a result is remembered, whatever the clock reads", () => {
    expect(decideReveal(remembered, noPlayed)).toBe("fire");
  });

  it("does nothing for a round already played", () => {
    const played = new Set([roundKey(remembered.roundId)]);
    expect(decideReveal(remembered, played)).toBe("nothing");
  });

  it("keys the played set by round id, not by object identity", () => {
    const played = new Set([roundKey(999n)]);
    expect(decideReveal(remembered, played)).toBe("fire");
  });
});

describe("idleBoardLabel", () => {
  it("says nothing while a round is open, paused or not", () => {
    expect(idleBoardLabel(true, true, true)).toBeNull();
  });
  it("says starts soon before the first epoch, whatever the game switch", () => {
    expect(idleBoardLabel(false, false, true)).toBe("STARTS SOON");
    expect(idleBoardLabel(false, false, false)).toBe("STARTS SOON");
  });
  it("says game paused between rounds once the game is paused", () => {
    expect(idleBoardLabel(false, true, true)).toBe("GAME PAUSED");
  });
  it("stays blank for a running game with no Round open", () => {
    expect(idleBoardLabel(false, true, false)).toBeNull();
  });

  // Longest Round 2 × 60 - 1 = 119 s, plus 60 s for the reveal: 179 s.
  it("uses the longest Round plus the reveal allowance for the epoch tail", () => {
    expect(longestRoundSeconds(60n)).toBe(119n);
    expect(idleBoardLabel(false, true, false, 1_820n, 2_000n, 60n)).toBeNull();
    expect(idleBoardLabel(false, true, false, 1_822n, 2_000n, 60n)).toBe("ROUND CLOSED, NEW DAY STARTS IN 178S");
    expect(idleBoardLabel(false, true, false, 1_999n, 2_000n, 60n)).toBe("ROUND CLOSED, NEW DAY STARTS IN 1S");
  });
  it("holds at zero until the next epoch begins", () => {
    expect(idleBoardLabel(false, true, false, 2_003n, 2_000n, 60n)).toBe("ROUND CLOSED, NEW DAY STARTS IN 0S");
  });
  it("goes blank again once the new epoch is current", () => {
    expect(idleBoardLabel(false, true, false, 2_003n, 88_400n, 60n)).toBeNull();
  });
  it("lets an open round or a paused game win over the countdown", () => {
    expect(idleBoardLabel(true, true, false, 1_990n, 2_000n, 60n)).toBeNull();
    expect(idleBoardLabel(false, true, true, 1_990n, 2_000n, 60n)).toBe("GAME PAUSED");
  });
});
