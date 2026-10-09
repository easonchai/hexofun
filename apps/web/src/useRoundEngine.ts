/**
 * The game choreography: maps protocol state onto the designer prototype's
 * phases and animation timeline. This hook adds only time-bound presentation
 * (laser path, dot pops, fly tokens, takeovers). The countdown reads the
 * server clock `clockNow` carries, the one `closeAt` is on.
 *
 * Off-chain-tickets ticket 18: the betting phase follows `/state`'s open Round
 * and the result follows its newest finished one, so a result can land after
 * the next Round has opened. A reveal can begin up to one poll interval after
 * the backend settles, since the browser learns on the next poll. That lag is
 * accepted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { isRowVisible, type RevealHoldState } from "./activityRows.js";
import { track } from "./analytics.js";
import {
  boardResult,
  covers,
  decideReveal,
  displayTile,
  phaseFor,
  potOf,
  roundKey,
  secondsLeft,
  type BoardResult,
  type FeedRow,
  type OpenRound,
  type Phase,
  type PositionLike,
  type ResultRound,
} from "./engine.js";
import {
  buildFlyTokens,
  computeGeo,
  genPath,
  type LaserPath,
} from "./arena/geo.js";
import { formatAtomic, formatAtomic2 } from "./lib/money.js";
import { sfx } from "./sfx.js";

const GEO = computeGeo();
/** The core shakes this long after the result lands before it detonates and
 *  the laser fires. Every reveal timer after the fire instant is shifted by
 *  this much. */
export const BUILDUP_MS = 2000;

export interface RevealState {
  /** Round id this reveal animates. */
  key: string;
  /** Protocol tile index 0..35. */
  winningTile: number;
  laser: LaserPath;
  /** Past the build-up: the core has detonated and the laser is travelling. */
  fired: boolean;
  boom: boolean;
  flyTokens: ReturnType<typeof buildFlyTokens>;
  /** dot key → fly launch delay; lattice symbols lift off with their token. */
  flyMap: Record<string, number>;
  /** Past the 4600 ms clear: the old lattice symbols are fading over 0.65 s. */
  clearing?: boolean;
}

export interface Takeover {
  title: string;
  amount: string;
  tileText: string;
}

export interface EngineOutput {
  phase: Phase;
  /** Seconds until the open Round closes, during "mine"; zero otherwise. */
  secondsLeft: bigint;
  /** Display numbers 1..36 the user has picked. */
  selected: number[];
  setSelected: (tiles: number[]) => void;
  /** "DRAWING" while a closed Round waits on its beacon; null when the board has a countdown or nothing to say. */
  result: BoardResult;
  reveal: RevealState | null;
  banner: string | null;
  takeover: Takeover | null;
  dismissTakeover: () => void;
  /** True for 0.85 s when a freshly opened Round's core is fading in. */
  coreEnter: boolean;
  /** Open Round pot in Tickets, for the stake panel; 0 on an idle board. */
  pot: bigint;
  lastWin: { tile: number; kind: string } | null;
  /** `input.feed`, with a held row's Round removed until the reveal lands. */
  feed: FeedRow[];
  /** The user's Position in the open Round, if any. */
  position: PositionLike | null;
}

export interface EngineInput {
  /** The open Round; null on an idle board. */
  open: OpenRound | null;
  /** The newest Round that is no longer open. */
  last: ResultRound | null;
  /** The wallet's Positions in those two Rounds, by Round id. */
  positions: ReadonlyMap<string, PositionLike>;
  owner: PublicKey | undefined;
  /** Server wall-clock seconds, the clock `open.closeAt` is on. */
  clockNow: bigint | null;
  /** The wallet's Tickets. A win pays through the ledger in the same poll
   *  that settles the Round, so its payout is the jump in this number. */
  tickets: bigint;
  /** Rows from the `GET /feed` poll; a row about the tracked Round's reveal
   *  is held here (see `activityRows.ts` `isRowVisible`) until it lands. */
  feed: FeedRow[];
}

/** A settled result kept by id, with what the wallet had in it when it landed. */
interface Remembered {
  round: ResultRound & { tile: number };
  position: PositionLike | null;
  /** Tickets the wallet gained in the poll that settled it. */
  reward: bigint;
}

export function useRoundEngine(input: EngineInput): EngineOutput {
  const { open, last, positions, owner, clockNow, tickets, feed } = input;

  const [selected, setSelected] = useState<number[]>([]);
  const [reveal, setRevealState] = useState<RevealState | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<Takeover | null>(null);
  const [lastWin, setLastWin] = useState<{ tile: number; kind: string } | null>(
    null,
  );

  const timeouts = useRef<number[]>([]);
  const later = useCallback((fn: () => void, ms: number): void => {
    const id = window.setTimeout(() => {
      timeouts.current = timeouts.current.filter((value) => value !== id);
      fn();
    }, ms);
    timeouts.current.push(id);
  }, []);

  useEffect(() => {
    return () => {
      timeouts.current.forEach(clearTimeout);
    };
  }, []);

  const setReveal = useCallback(
    (next: RevealState | null) => setRevealState(next),
    [],
  );

  // --- Round reveal choreography --------------------------------------------
  // `last` moves on to the next finished Round, so the first settled sighting
  // of each id is kept here, independent of whatever `last` currently is —
  // the source of truth for "is there a result to fire" and "what does it
  // pay". `played` is the set `decideReveal` checks; `revealBusyRef` gates
  // one reveal at a time, queuing a second result behind the 4600 ms clear.
  const rememberedRef = useRef<Map<string, Remembered>>(new Map());
  const playedRef = useRef<Set<string>>(new Set());
  const seenAnyRoundRef = useRef(false);
  const revealBusyRef = useRef(false);
  const ticketsBeforeRef = useRef(tickets);

  // --- Derived phase ----------------------------------------------------------
  // The next countdown waits for the result to be shown: through the reveal up
  // to its 4600 ms clear, and for the render between a settled poll and the
  // effect below starting that reveal (a page opened late never animates it).
  const now = clockNow ?? 0n;
  const settledUnplayed =
    last?.status === "settled" &&
    last.tile !== null && // the effect below skips a tileless one, so it never plays
    seenAnyRoundRef.current &&
    !playedRef.current.has(roundKey(last.roundId));
  const revealing = (reveal !== null && !reveal.clearing) || settledUnplayed;
  const phase = phaseFor(open, now, last, revealing);
  const activeSecondsLeft = phase === "mine" ? secondsLeft(open, now) : 0n;
  const result = boardResult(phase, open, last, revealing);

  const runReveal = useCallback(
    ({ round: target, position: own, reward }: Remembered, key: string, onDone: () => void) => {
      const tileIndex = target.tile;
      if (tileIndex < 0 || tileIndex > 35) {
        onDone(); // out of range: nothing to animate, unblock the queue
        return;
      }
      const tile = GEO.tiles[tileIndex]!;

      const won = Boolean(own && covers(own.tiles, tileIndex));
      // Everything from the fire instant on is timed after the build-up.
      const afterFire = (fn: () => void, ms: number): void =>
        later(fn, ms + BUILDUP_MS);
      if (own && !won) afterFire(() => sfx("miss"), 900);

      const laser = genPath(GEO, tile.x, tile.y);
      afterFire(() => sfx("launch"), 0);
      for (const info of Object.values(laser.activeDotTimes)) {
        afterFire(() => sfx("dotTick"), Math.round(info.delay * 1000));
      }

      const flyTokens = buildFlyTokens(laser.activeDotTimes, tile);
      const flyMap: Record<string, number> = {};
      Object.keys(laser.activeDotTimes).forEach((dotKey, index) => {
        if (index < flyTokens.length - 1)
          flyMap[dotKey] = flyTokens[index]!.delay;
      });

      // The core shakes through the build-up first; at BUILDUP_MS the core
      // detonates and the laser fires, in step with the launch and dot-tick
      // sounds. The tile is only announced (boom, banner, fly tokens) once
      // the beam lands 900 ms after that, so it visibly travels to the number.
      setReveal({
        key,
        winningTile: tileIndex,
        laser,
        fired: false,
        boom: false,
        flyTokens: [],
        flyMap: {},
      });

      afterFire(() => {
        setRevealState((current) =>
          current && current.key === key ? { ...current, fired: true } : current,
        );
      }, 0);

      afterFire(() => {
        sfx("land");
        setRevealState((current) =>
          current && current.key === key
            ? { ...current, boom: true, flyTokens, flyMap }
            : current,
        );
        setBanner(`TILE ${displayTile(tileIndex)} WINS`);
        setLastWin({ tile: displayTile(tileIndex), kind: "ROUND" });
      }, 900);

      for (const token of flyTokens) {
        afterFire(
          () => sfx("feed"),
          Math.round((token.delay + 0.68) * 1000) + 900,
        );
      }

      if (won) {
        afterFire(() => {
          sfx("win");
          setTakeover({
            title: "YOU WON",
            amount: `+${formatAtomic2(reward, 6)}`,
            tileText: `Tile ${displayTile(tileIndex)}`,
          });
        }, 1550);
      }

      afterFire(() => {
        setBanner(null);
        // The old lattice symbols fade over 0.65 s rather than vanishing
        // outright; unblock the queue now, at the clear, not after the fade.
        setRevealState((current) =>
          current && current.key === key
            ? { ...current, clearing: true }
            : current,
        );
        onDone();
        later(() => {
          setRevealState((current) =>
            current && current.key === key ? null : current,
          );
        }, 650);
      }, 4600);
    },
    [later],
  );

  /** Oldest remembered-but-unplayed Round ready to fire, or start it now. */
  const pump = useCallback(() => {
    if (revealBusyRef.current) return;
    let candidate: Remembered | null = null;
    for (const entry of rememberedRef.current.values()) {
      if (playedRef.current.has(roundKey(entry.round.roundId))) continue;
      if (!candidate || entry.round.roundId < candidate.round.roundId) candidate = entry;
    }
    if (!candidate) return;
    const key = roundKey(candidate.round.roundId);
    if (decideReveal(candidate.round, playedRef.current) !== "fire") return;
    playedRef.current.add(key);
    revealBusyRef.current = true;
    runReveal(candidate, key, () => {
      revealBusyRef.current = false;
      pump();
    });
  }, [runReveal]);

  // Remember every settled Round `/state` shows, once, by id. A Round already
  // settled the first time this session ever sees any round (page opened
  // mid-reveal or later) is marked played without animating it.
  useEffect(() => {
    if (!open && !last) return;
    const firstRoundSeen = !seenAnyRoundRef.current;
    seenAnyRoundRef.current = true;
    if (last?.status !== "settled" || last.tile === null) return;
    const key = roundKey(last.roundId);
    if (rememberedRef.current.has(key)) return;
    const position = owner ? (positions.get(key) ?? null) : null;
    const reward = position && tickets > ticketsBeforeRef.current ? tickets - ticketsBeforeRef.current : 0n;
    rememberedRef.current.set(key, { round: { ...last, tile: last.tile }, position, reward });
    if (firstRoundSeen) {
      playedRef.current.add(key);
      return;
    }
    if (position) {
      track("position_settled", {
        won: covers(position.tiles, last.tile),
        reward: Number(formatAtomic(reward, 6)),
      });
    }
    pump();
  }, [open, last, positions, owner, tickets, pump]);
  // After the effect above, so it still sees the previous poll's balance.
  useEffect(() => {
    ticketsBeforeRef.current = tickets;
  }, [tickets]);

  // --- Core fade-in + prime sound when a fresh Round opens --------------------
  // The picks stay: a player who just bet sees their tiles, and one who did
  // not can bet the same board again.
  const [coreEnter, setCoreEnter] = useState(false);
  const lastOpenRoundRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const key = roundKey(open.roundId);
    if (lastOpenRoundRef.current === key) return;
    const isFirstRoundEver = lastOpenRoundRef.current === null;
    lastOpenRoundRef.current = key;
    if (isFirstRoundEver) return; // no fade-in/chime for the very first Round on load
    sfx("prime");
    setCoreEnter(true);
    later(() => setCoreEnter(false), 850);
  }, [open, later]);

  // --- Tick sound at 3, 2, 1 seconds, driven by the server clock -------------
  const tickedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!open) return;
    if (phase !== "mine") return;
    if (activeSecondsLeft < 1n || activeSecondsLeft > 3n) return;
    const key = `${roundKey(open.roundId)}:${activeSecondsLeft}`;
    if (tickedRef.current.has(key)) return;
    tickedRef.current.add(key);
    sfx("tick");
  }, [open, phase, activeSecondsLeft]);

  // --- Activity feed hold: a held row appears with the land ------------------
  // Reuses the choreography state above rather than a parallel copy: a Round
  // is "pending" once remembered but not yet fired, "firing" from the fire
  // instant up to the 900 ms land (reveal.boom flips true exactly there,
  // alongside ticket 05's land sound and banner), and otherwise visible.
  const revealHoldFor = (roundId: string | undefined): RevealHoldState => {
    if (roundId === undefined) return "none";
    if (reveal && reveal.key === roundId) return reveal.boom ? "landed" : "firing";
    if (rememberedRef.current.has(roundId) && !playedRef.current.has(roundId))
      return "pending";
    return "none";
  };
  const visibleFeed = feed.filter((row) =>
    isRowVisible(row, revealHoldFor(row.roundId)),
  );

  return {
    phase,
    secondsLeft: activeSecondsLeft,
    selected,
    setSelected,
    result,
    reveal,
    banner,
    takeover,
    dismissTakeover: () => setTakeover(null),
    coreEnter,
    pot: potOf(open),
    lastWin,
    feed: visibleFeed,
    position: owner && open ? (positions.get(roundKey(open.roundId)) ?? null) : null,
  };
}
