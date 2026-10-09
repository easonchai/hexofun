/**
 * HOME tab: the Figma "Landing" frame. Today's prize (the yield the pool
 * earned this epoch, the same current-Epoch value DAILY DRAW labels
 * "Prize") as a whole-dollar hero, a DD:HH:MM:SS clock to `endsAt`, and
 * one button that jumps to the VAULT tab.
 *
 * Ticket 07: `currentEpoch` comes from App's one `GET /state` poll instead
 * of a duplicate `/epochs/current` poll of its own.
 */
import { useEffect, useState } from "react";

import type { CurrentEpochDto } from "../api.js";
import { JACKPOT_GATED } from "../chain.js";
import { dhmsParts } from "../engine.js";
import {
  isDrawing,
  launchCountdown,
  launchCountdownLabel,
  prizeCardState,
  showsNextDrawLabel,
} from "../launch.js";

export interface HomeProps {
  /** Chain clock seconds, for the draw countdown. */
  now: bigint | null;
  currentEpoch: CurrentEpochDto | null;
  /** Ticket 05: `/state`'s `launchAt`, present only while `currentEpoch` is
   *  null (the deposit-only launch week). */
  launchAt: string | null;
  /** game-jackpot-pause: the draw is held, so the clock says so instead of
   *  counting to a draw that will not run on schedule. */
  jackpotPaused: boolean;
  onDeposit: () => void;
}

/** Atomic string (6dp) → "$24,891". Whole dollars only, matching the design. */
export function wholeDollars(atomic: string): string {
  const clean = atomic.replace(/[^0-9]/g, "") || "0";
  return `$${(BigInt(clean) / 1_000_000n).toLocaleString("en-US")}`;
}

const CLOCK_LABELS = ["DAYS", "HRS", "MIN", "SEC"] as const;

/** Hand-traced from the Figma glyph row: star, square, target, cross, frame, plus. */
const GLYPHS = [
  <path d="M12 2.5l2.7 6 6.3.6-4.8 4.3 1.5 6.4L12 16.5l-5.7 3.3 1.5-6.4L3 9.1l6.3-.6z" />,
  <rect x="4" y="4" width="16" height="16" rx="4" fill="none" strokeWidth="3" />,
  <g fill="none" strokeWidth="3">
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="2" strokeWidth="2" />
  </g>,
  <path d="M5 5l14 14M19 5L5 19" fill="none" strokeWidth="3.5" />,
  <g>
    <rect x="4" y="4" width="16" height="16" rx="4" fill="none" strokeWidth="3" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
  </g>,
  <path d="M12 3v18M3 12h18" fill="none" strokeWidth="6" />,
];

/** How many glyphs in a row turn on each tick, and how often a tick fires. */
const GLYPHS_PER_TICK = 3;
const GLYPH_TICK_MS = 1000;
const GLYPH_TURN_DEG = 45;

/** Distinct random glyph indexes, `count` of them (capped at the row length). */
function pickGlyphs(count: number): Set<number> {
  const picks = new Set<number>();
  while (picks.size < Math.min(count, GLYPHS.length)) {
    picks.add(Math.floor(Math.random() * GLYPHS.length));
  }
  return picks;
}

/** Six brand glyphs, three of which turn 45° every second. Shared with the Vault. */
export function GlyphRow() {
  const [turns, setTurns] = useState(() => GLYPHS.map(() => 0));

  useEffect(() => {
    const id = setInterval(() => {
      const picks = pickGlyphs(GLYPHS_PER_TICK);
      setTurns((prev) =>
        prev.map((deg, i) =>
          picks.has(i) ? deg + (Math.random() < 0.5 ? -GLYPH_TURN_DEG : GLYPH_TURN_DEG) : deg,
        ),
      );
    }, GLYPH_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="home-glyphs" aria-hidden="true">
      {GLYPHS.map((glyph, i) => (
        <svg
          key={i}
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="currentColor"
          stroke="currentColor"
          strokeLinecap="round"
          style={{ transform: `rotate(${turns[i]}deg)` }}
        >
          {glyph}
        </svg>
      ))}
    </span>
  );
}

export const Star = () => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
    {GLYPHS[0]}
  </svg>
);

export function Home({ now, currentEpoch, launchAt, jackpotPaused, onDeposit }: HomeProps) {
  const remaining =
    currentEpoch && now !== null ? BigInt(currentEpoch.endsAt) - now : null;
  const drawing = currentEpoch?.drawing !== null && currentEpoch?.drawing !== undefined;
  // No epoch and no LAUNCH_AT: the clock sits at zero. "--" is only for an
  // unknown chain clock; "Coming soon" is the jackpot gate's.
  const parts =
    remaining !== null ? dhmsParts(remaining) : currentEpoch === null ? dhmsParts(0n) : null;
  // Ticket 05: no Epoch yet (deposit-only launch week) counts down to
  // LAUNCH_AT instead of an Epoch's endsAt. Ticket 02 (feature-gates): the
  // jackpot gate takes the same "launch" branch, live epoch or not, and
  // ignores LAUNCH_AT so it always reads "Coming soon".
  const cardState = prizeCardState(
    JACKPOT_GATED,
    currentEpoch !== null,
    jackpotPaused,
    launchAt !== null,
  );
  const launchLabel =
    cardState === "launch"
      ? launchCountdownLabel(launchCountdown(JACKPOT_GATED ? null : launchAt, now))
      : null;

  return (
    <div className="home" data-testid="home-screen">
      {/* Pre-dithered coin ring (scripts/dither-video.mjs). Without autoplay the poster stays. */}
      <video
        className="home-bg"
        src="/home-bg.mp4"
        poster="/home-bg.png"
        autoPlay={!window.matchMedia("(prefers-reduced-motion: reduce)").matches}
        muted
        loop
        playsInline
        aria-hidden="true"
      />
      <div className="home-hero">
        <div className="home-pill-row">
          <Star />
          <span className="home-pill">CURRENT PRIZE POOL</span>
          <Star />
        </div>
        <div className="home-amount" data-testid="home-prize">
          {currentEpoch ? wholeDollars(currentEpoch.jackpotAmount) : "$—"}
        </div>
        <p className="home-tagline">
          Save your <em>money</em>, play your <em>luck</em>
        </p>
      </div>

      <div className="home-clock">
        <div className="home-clock-label">
          {showsNextDrawLabel(cardState, drawing, remaining)
            ? "DAILY PRIZE DRAW · NEXT DRAW IN"
            : "DAILY PRIZE DRAW"}
        </div>
        {cardState === "launch" ? (
          <div className="home-drawing" data-testid="home-launch-countdown">
            {launchLabel}
          </div>
        ) : cardState === "paused" ? (
          <div className="home-drawing" data-testid="home-draw-paused">
            DRAW PAUSED
          </div>
        ) : isDrawing(drawing, remaining) ? (
          <div className="home-drawing" data-testid="home-drawing">
            DRAWING…
          </div>
        ) : (
          <div className="home-clock-boxes" data-testid="home-countdown">
            {CLOCK_LABELS.map((label, i) => (
              <div key={label} className="home-clock-unit">
                <div className="home-clock-box">{parts ? parts[i] : "--"}</div>
                <div className="home-clock-unit-label">{label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="home-cta-row">
        <GlyphRow />
        <button
          type="button"
          className="home-cta"
          data-testid="home-deposit"
          onClick={onDeposit}
        >
          DEPOSIT NOW
        </button>
        <GlyphRow />
      </div>

      <div className="home-footer">
        <span>NO-LOSS</span>
        <Star />
        <span>DAILY PRIZE DRAWS</span>
        <Star />
        <span>YOUR DEPOSIT IS NEVER TOUCHED</span>
      </div>
    </div>
  );
}
