/**
 * The game choreography: maps protocol state onto the designer prototype's
 * phases and animation timeline. This hook adds only time-bound presentation
 * (laser path, dot pops, fly tokens, takeovers). All timings derive from
 * chain time via the chain clock.
 *
 * Ticket 07: inputs come from the consolidated `GET /state` poll and the
 * `GET /feed` poll instead of a chain account batch and a log subscription
 * — see `useStatePoll.ts` and `App.tsx`. One consequence: a Round's reveal
 * can now begin up to one poll interval after it actually settles, since the
 * browser learns about it on the next poll rather than the instant a log
 * arrives. That lag is accepted.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { isRowVisible, type RevealHoldState } from "./activityRows.js";
import {
  covers,
  decideReveal,
  displayTile,
  expectedReward,
  isRevealed,
  phaseFor,
  ROUND_OPEN,
  roundKey,
  secondsLeft,
  type FeedRow,
  type Phase,
  type PositionLike,
  type RoundLike,
} from "./engine.js";
import {
  buildFlyTokens,
  computeGeo,
  genPath,
  type LaserPath,
} from "./arena/geo.js";
import { formatAtomic2 } from "./lib/money.js";
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
  /** Seconds until positions close, during "mine"; zero otherwise. */
  secondsLeft: bigint;
  /** Display numbers 1..36 the user has picked. */
  selected: number[];
  setSelected: (tiles: number[]) => void;
  /** The round once it has revealed a winning tile; null before that. */
  settled: RoundLike | null;
  reveal: RevealState | null;
  banner: string | null;
  takeover: Takeover | null;
  dismissTakeover: () => void;
  /** True for 0.85 s when a freshly opened Round's core is fading in. */
  coreEnter: boolean;
  /** Round pot in Tickets, for the stake panel. */
  pot: bigint;
  lastWin: { tile: number; kind: string } | null;
  /** `input.feed`, with a held row's Round removed until the reveal lands. */
  feed: FeedRow[];
  /** The user's position in the tracked round, if any. */
  activePosition: PositionLike | null;
}

export interface EngineInput {
  round: RoundLike | null;
  position: PositionLike | null;
  owner: PublicKey | undefined;
  closeBuffer: bigint;
  clockNow: bigint | null;
  /** Rows from the `GET /feed` poll; a row about the tracked Round's reveal
   *  is held here (see `activityRows.ts` `isRowVisible`) until it lands. */
  feed: FeedRow[];
}

export function useRoundEngine(input: EngineInput): EngineOutput {
  const {
    round,
    position,
    owner,
    closeBuffer: buffer,
    clockNow,
    feed,
  } = input;

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

  // --- Derived phase ----------------------------------------------------------
  const now = clockNow ?? 0n;
  const phase = phaseFor(round, now, buffer);
  const activeSecondsLeft = round ? secondsLeft(round, buffer, now) : 0n;

  // --- Round reveal choreography --------------------------------------------
  // A Round's chain object stops being what `round` returns once the next
  // Round opens, so the first revealed (Settled or Forfeited) sighting of
  // each id is kept here, independent of whatever `round` currently is —
  // the source of truth for "is there a result to fire" and "what does it
  // pay". `played` is the set `decideReveal` checks; `revealBusyRef` gates
  // one reveal at a time, queuing a second result behind the 4600 ms clear.
  const settled = round && isRevealed(round) ? round : null;
  const rememberedRef = useRef<Map<string, RoundLike>>(new Map());
  const playedRef = useRef<Set<string>>(new Set());
  const seenAnyRoundRef = useRef(false);
  const revealBusyRef = useRef(false);

  const runReveal = useCallback(
    (target: RoundLike, key: string, onDone: () => void) => {
      const tileIndex = target.winningTile;
      if (tileIndex < 0 || tileIndex > 35) {
        onDone(); // u8::MAX = "unset" guard — nothing to animate, unblock the queue
        return;
      }
      const tile = GEO.tiles[tileIndex]!;

      const own = owner ? position : null;
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
        const reward = expectedReward(target, own!);
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
    [owner, position, later],
  );

  /** Oldest remembered-but-unplayed Round ready to fire, or start it now. */
  const pump = useCallback(() => {
    if (revealBusyRef.current) return;
    let candidate: RoundLike | null = null;
    for (const entry of rememberedRef.current.values()) {
      if (playedRef.current.has(roundKey(entry.roundId))) continue;
      if (!candidate || entry.roundId < candidate.roundId) candidate = entry;
    }
    if (!candidate) return;
    const key = roundKey(candidate.roundId);
    if (decideReveal(candidate, playedRef.current) !== "fire") return;
    playedRef.current.add(key);
    revealBusyRef.current = true;
    runReveal(candidate, key, () => {
      revealBusyRef.current = false;
      pump();
    });
  }, [runReveal]);

  // Remember every revealed Round the chain read shows, once, by id. A Round
  // already revealed the first time this session ever sees any round (page
  // opened mid-reveal or later) is marked played without animating it.
  useEffect(() => {
    if (!round) return;
    const firstRoundSeen = !seenAnyRoundRef.current;
    seenAnyRoundRef.current = true;
    if (!isRevealed(round)) return;
    const key = roundKey(round.roundId);
    if (rememberedRef.current.has(key)) return;
    rememberedRef.current.set(key, round);
    if (firstRoundSeen) {
      playedRef.current.add(key);
      return;
    }
    pump();
  }, [round, pump]);

  // --- Core fade-in + prime sound when a fresh Round opens --------------------
  const [coreEnter, setCoreEnter] = useState(false);
  const lastOpenRoundRef = useRef<string | null>(null);
  useEffect(() => {
    if (!round || round.status !== ROUND_OPEN) return;
    const key = roundKey(round.roundId);
    if (lastOpenRoundRef.current === key) return;
    const isFirstRoundEver = lastOpenRoundRef.current === null;
    lastOpenRoundRef.current = key;
    if (isFirstRoundEver) return; // no fade-in/chime for the very first Round on load
    // Last round's picks are stale on a fresh board. Auto-rounds re-select
    // after it re-deploys, and App's effect runs after this one.
    setSelected([]);
    sfx("prime");
    setCoreEnter(true);
    later(() => setCoreEnter(false), 850);
  }, [round, later]);

  // --- Tick sound at 3, 2, 1 seconds, driven by the chain clock ---------------
  const tickedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!round) return;
    if (phase !== "mine") return;
    if (activeSecondsLeft < 1n || activeSecondsLeft > 3n) return;
    const key = `${roundKey(round.roundId)}:${activeSecondsLeft}`;
    if (tickedRef.current.has(key)) return;
    tickedRef.current.add(key);
    sfx("tick");
  }, [round, phase, activeSecondsLeft]);

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
    settled,
    reveal,
    banner,
    takeover,
    dismissTakeover: () => setTakeover(null),
    coreEnter,
    pot: round?.pot ?? 0n,
    lastWin,
    feed: visibleFeed,
    activePosition: owner ? position : null,
  };
}
