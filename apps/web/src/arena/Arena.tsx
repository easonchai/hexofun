/**
 * Hexagon arena — React port of the "HEX Voltage Refined" prototype stage:
 * countdown, hexagon outline, dot lattice, cog core, laser reveal, 36 tiles,
 * victory shockwaves, round pot pill, and the win takeover modal.
 */
import { useEffect, useMemo, useRef } from "react";

import { computeGeo } from "./geo.js";
import { Textile } from "./Textile.js";
import { GAME_GATED } from "../chain.js";
import { ComingSoon } from "../ComingSoon.js";
import { timerText } from "../engine.js";
import { formatAtomic2 } from "../lib/money.js";
import type { EngineOutput } from "../useRoundEngine.js";

const GEO = computeGeo();

export function LogoCog({
  size = 28,
  color = "currentColor",
}: {
  size?: number;
  color?: string;
}) {
  // Brand logomark (BrandKit_HEXO/Logo/Logomark) — hex cluster around an x.
  // Cropped to the glyph bbox of the 250×250 artboard, so `size` is the drawn
  // height with no padding to compensate for.
  return (
    <svg
      width={size * (153.608 / 170.328)}
      height={size}
      viewBox="48 40 153.608 170.328"
      fill="none"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path
        d="M143.829 167.239C145.998 168.595 147.314 170.972 147.314 173.53V193.469C147.314 196.027 145.997 198.404 143.829 199.76L128.74 209.199C126.332 210.704 123.277 210.704 120.87 209.199L105.78 199.76C103.612 198.404 102.295 196.027 102.295 193.469V173.53C102.295 170.972 103.612 168.595 105.78 167.239L120.869 157.8C123.277 156.294 126.333 156.294 128.74 157.8L143.829 167.239ZM89.5345 81.3022C91.7026 82.6585 93.0195 85.0357 93.0195 87.5931V107.532C93.0195 110.089 91.7025 112.466 89.5343 113.823L81.4613 118.872C76.8144 121.779 76.8143 128.547 81.4611 131.454L89.5345 136.504C91.7026 137.861 93.0195 140.238 93.0195 142.795V162.735C93.0195 165.292 91.7025 167.669 89.5343 169.026L74.4448 178.464C72.0375 179.97 68.982 179.97 66.5747 178.464L51.4853 169.026C49.317 167.669 48 165.292 48 162.735V142.795C48 140.238 49.3169 137.861 51.4849 136.504L59.558 131.454C64.2047 128.547 64.2046 121.779 59.5578 118.872L51.4851 113.823C49.317 112.466 48 110.089 48 107.532V87.5931C48 85.0357 49.3169 82.6585 51.4851 81.3022L66.5745 71.863C68.9819 70.357 72.0376 70.357 74.445 71.863L89.5345 81.3022ZM198.121 81.3042C200.289 82.6605 201.606 85.0377 201.606 87.5952V107.534C201.606 110.092 200.289 112.469 198.121 113.825L190.051 118.873C185.404 121.78 185.404 128.548 190.051 131.455L198.123 136.504C200.291 137.861 201.608 140.238 201.608 142.795V162.735C201.608 165.292 200.291 167.669 198.123 169.026L183.034 178.464C180.626 179.97 177.571 179.97 175.164 178.464L160.074 169.026C157.906 167.669 156.589 165.292 156.589 162.735V142.795C156.589 140.238 157.906 137.861 160.074 136.504L168.144 131.456C172.791 128.549 172.791 121.781 168.144 118.874L160.072 113.825C157.904 112.469 156.587 110.092 156.587 107.534V87.5952C156.587 85.0377 157.904 82.6605 160.072 81.3042L175.162 71.8656C177.569 70.3598 180.624 70.3598 183.032 71.8656L198.121 81.3042ZM143.826 50.5679C145.995 51.9241 147.312 54.3013 147.312 56.8588V76.7984C147.312 79.3558 145.995 81.7329 143.827 83.0892L128.738 92.5283C126.331 94.0343 123.275 94.0343 120.867 92.5284L105.778 83.0892C103.61 81.7329 102.293 79.3557 102.293 76.7983V56.8589C102.293 54.3014 103.61 51.9241 105.778 50.5679L120.868 41.1293C123.275 39.6235 126.331 39.6236 128.738 41.1294L143.826 50.5679Z"
        fill={color}
      />
      <path
        d="M132 118L117.571 132.429"
        stroke={color}
        strokeWidth="11.1305"
        strokeLinecap="round"
      />
      <path
        d="M118 118L132.429 132.429"
        stroke={color}
        strokeWidth="11.1305"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Brand wordmark (BrandKit_HEXO/Logo/Logo) — the drawn "HEXO" letterforms.
 * Cropped to the glyph bbox of the full lockup, so `height` sets it exactly.
 */
export function LogoWordmark({
  height = 20,
  color = "currentColor",
}: {
  height?: number;
  color?: string;
}) {
  return (
    <svg
      height={height}
      width={height * (375.156 / 67.781)}
      viewBox="301 90 375.156 67.781"
      fill="none"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path
        d="M676.156 123.891C676.156 129.422 675.141 134.312 673.109 138.562C671.078 142.781 668.172 146.312 664.391 149.156C660.609 152 656.016 154.156 650.609 155.625C645.234 157.062 639.188 157.781 632.469 157.781C625.75 157.781 619.672 157.062 614.234 155.625C608.828 154.156 604.219 152 600.406 149.156C596.594 146.312 593.656 142.781 591.594 138.562C589.531 134.312 588.5 129.422 588.5 123.891C588.5 118.359 589.531 113.484 591.594 109.266C593.656 105.016 596.594 101.469 600.406 98.625C604.219 95.7812 608.828 93.6406 614.234 92.2031C619.672 90.7344 625.75 90 632.469 90C639.188 90 645.234 90.7344 650.609 92.2031C656.016 93.6406 660.609 95.7812 664.391 98.625C668.172 101.469 671.078 105.016 673.109 109.266C675.141 113.484 676.156 118.359 676.156 123.891ZM658.578 123.891C658.578 121.484 658.188 119.094 657.406 116.719C656.656 114.312 655.297 112.156 653.328 110.25C651.391 108.344 648.734 106.797 645.359 105.609C641.984 104.422 637.688 103.828 632.469 103.828C628.969 103.828 625.891 104.109 623.234 104.672C620.578 105.203 618.281 105.953 616.344 106.922C614.406 107.891 612.781 109.031 611.469 110.344C610.156 111.625 609.109 113.016 608.328 114.516C607.547 115.984 606.984 117.531 606.641 119.156C606.328 120.75 606.172 122.328 606.172 123.891C606.172 125.484 606.328 127.094 606.641 128.719C606.984 130.344 607.547 131.906 608.328 133.406C609.109 134.875 610.156 136.25 611.469 137.531C612.781 138.812 614.406 139.938 616.344 140.906C618.281 141.844 620.578 142.594 623.234 143.156C625.891 143.688 628.969 143.953 632.469 143.953C637.688 143.953 641.984 143.359 645.359 142.172C648.734 140.984 651.391 139.438 653.328 137.531C655.297 135.625 656.656 133.484 657.406 131.109C658.188 128.703 658.578 126.297 658.578 123.891Z"
        fill={color}
      />
      <path
        d="M545.254 118.926C543.126 121.226 543.126 124.775 545.253 127.075L562.73 145.973C566.284 149.815 563.559 156.047 558.325 156.047H553.804C552.135 156.047 550.542 155.352 549.407 154.13L535.438 139.089C533.06 136.529 529.007 136.533 526.636 139.099L512.75 154.12C511.615 155.348 510.017 156.047 508.344 156.047H503.863C498.632 156.047 495.907 149.82 499.455 145.976L516.909 127.075C519.034 124.774 519.032 121.227 516.905 118.929L500.978 101.715C497.424 97.8738 500.148 91.6406 505.382 91.6406H509.88C511.56 91.6406 513.162 92.3447 514.299 93.5816L526.624 106.999C528.997 109.582 533.071 109.588 535.451 107.01L547.859 93.5705C548.995 92.3403 550.593 91.6406 552.267 91.6406H556.774C562.008 91.6406 564.733 97.8738 561.178 101.715L545.254 118.926Z"
        fill={color}
      />
      <path
        d="M414.187 156.047C410.874 156.047 408.188 153.361 408.188 150.047V97.6406C408.188 94.3269 410.874 91.6406 414.188 91.6406H467.391C470.704 91.6406 473.391 94.3269 473.391 97.6406V99.375C473.391 102.689 470.704 105.375 467.391 105.375H431.367C428.429 105.375 426.047 107.757 426.047 110.695C426.047 113.634 428.429 116.016 431.367 116.016H464.953C468.267 116.016 470.953 118.702 470.953 122.016V123.75C470.953 127.064 468.267 129.75 464.953 129.75H432.047C428.733 129.75 426.047 132.436 426.047 135.75V136.312C426.047 139.626 428.733 142.312 432.047 142.312H468.047C471.361 142.312 474.047 144.999 474.047 148.312V150.047C474.047 153.361 471.361 156.047 468.047 156.047H414.187Z"
        fill={color}
      />
      <path
        d="M368.641 156.047C365.327 156.047 362.641 153.361 362.641 150.047V135.188C362.641 131.874 359.954 129.188 356.641 129.188H324.391C321.077 129.188 318.391 131.874 318.391 135.188V150.047C318.391 153.361 315.704 156.047 312.391 156.047H307C303.686 156.047 301 153.361 301 150.047V97.6406C301 94.3269 303.686 91.6406 307 91.6406H312.391C315.704 91.6406 318.391 94.3269 318.391 97.6406V109.078C318.391 112.392 321.077 115.078 324.391 115.078H356.641C359.954 115.078 362.641 112.392 362.641 109.078V97.6406C362.641 94.3269 365.327 91.6406 368.641 91.6406H374.031C377.345 91.6406 380.031 94.3269 380.031 97.6406V150.047C380.031 153.361 377.345 156.047 374.031 156.047H368.641Z"
        fill={color}
      />
    </svg>
  );
}

export function RoundPotPill({ value }: { value: bigint }) {
  return (
    <div
      className="hexpot"
      data-testid="round-pot-pill"
      data-value={value.toString()}
    >
      <div className="hexpot-info-wrap">
        <span className="hexpot-label">ROUND POT</span>
        <span className="info-bubble-icon">i</span>
        <div className="hexpot-tooltip">
          <div className="hexpot-tooltip-title">ROUND POT</div>
          <div>
            Tickets everyone has staked on this round. The House takes a cut
            and the winning tiles split the rest.
          </div>
        </div>
      </div>
      <span className="hp-value">{formatAtomic2(value, 6)}</span>
      <span className="hexpot-symbol">Tickets</span>
    </div>
  );
}

export interface ArenaProps {
  engine: EngineOutput;
  canPick: boolean;
  onToggleTile: (displayNumber: number) => void;
  /** True when the backend status pill is amber: the operator isn't ticking. */
  operatorStale?: boolean;
  /** `idleBoardLabel`'s answer: shown in the timer's spot while there is no
   *  countdown, so an empty board says why it is empty. */
  idleLabel?: string | null;
}

export function Arena({
  engine,
  canPick,
  onToggleTile,
  operatorStale = false,
  idleLabel = null,
}: ArenaProps) {
  const {
    phase,
    secondsLeft,
    selected,
    reveal,
    banner,
    pot,
    coreEnter,
    takeover,
    dismissTakeover,
    result,
  } = engine;

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // The winner lights up when the laser lands (boom), not when it launches.
  const winDisplay = reveal?.boom ? reveal.winningTile + 1 : 0;
  // Lattice symbols pop along the beam, so they wait for the fire instant too.
  const revealDots = reveal?.fired ? reveal.laser.activeDotTimes : {};
  const flyMap = reveal?.flyMap ?? {};
  const seconds = Number(secondsLeft);
  const revealing = result?.kind === "revealing";
  // The countdown ends at the close; from there the draw waits on its beacon,
  // whose length is drand's, so the timer says what is happening instead.
  const timerLabel = phase === "mine" ? timerText(secondsLeft) : revealing ? "REVEALING" : null;
  const timerRed = phase === "mine" && seconds <= 2;
  // No countdown and no reveal under way: a voided Round, else the idle label.
  const boardLabel = result?.kind === "voided" ? "ROUND VOIDED, STAKES REFUNDED" : idleLabel;

  // Idle through the countdown and the draw; when the result lands the core
  // shakes hard for the build-up, then detonates as the laser fires.
  const coreLive = phase !== "idle" || revealing;
  const shake =
    reveal && !reveal.fired
      ? "hexShake .08s infinite"
      : coreLive
        ? "hexShakeSubtle .25s infinite"
        : "none";

  const arenaWrapRef = useRef<HTMLDivElement>(null);
  // Phone board scale (spec.md "Board scale"): the smaller of a width-based
  // and height-based factor, capped at the desktop scale. CSS `min()` with
  // length division (`calc(100vw / 620)` producing a bare number) is the
  // spec's preferred approach, but neither Chromium nor WebKit in this
  // repo's Playwright accept it as a `scale()` argument (verified with
  // `CSS.supports`), so it's computed here instead and handed to the
  // `@media (max-width: 960px)` rule in styles.css as one custom property,
  // read there as `scale(var(--board-scale, 0.64))`. Above 960px that
  // property is never read, so this is a no-op on desktop.
  useEffect(() => {
    const wrap = arenaWrapRef.current;
    if (!wrap) return;
    const DESKTOP_SCALE = 0.64;
    const SIDE_MARGIN = 24;
    // ponytail: rounded estimate of the timer (~48px above the box) plus
    // the in-flow hexpot pill below it (~50px incl. its gap), not a
    // measured constant; revisit if either one's size changes.
    const RESERVED_HEIGHT = 100;
    const updateScale = () => {
      const { width, height } = wrap.getBoundingClientRect();
      const widthFactor = (width - SIDE_MARGIN) / 620;
      const heightFactor = (height - RESERVED_HEIGHT) / 600;
      const scale = Math.min(widthFactor, heightFactor, DESKTOP_SCALE);
      wrap.style.setProperty("--board-scale", String(Math.max(scale, 0.01)));
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="stage-arena-wrap" data-testid="arena" ref={arenaWrapRef}>
      <div className="hex-stage-container">
        {/* Timer / win banner above the hexagon */}
        {timerLabel !== null && !banner ? (
          <div
            className={`stage-timer${operatorStale ? " stage-timer-stale" : ""}${timerRed && !operatorStale ? " stage-timer-red" : ""}`}
            data-testid="round-timer"
          >
            {operatorStale ? "OPERATOR PAUSED" : timerLabel}
          </div>
        ) : !banner && boardLabel ? (
          <div className="stage-timer stage-timer-stale" data-testid="board-idle-label">
            {boardLabel}
          </div>
        ) : null}
        {result?.kind === "revealing" && !banner ? (
          <div className="stage-commitment" data-testid="seed-commitment" title="sha256 of the seed this Round reveals">
            seed commitment {result.seedCommitment}
          </div>
        ) : null}
        {banner ? (
          <div className="win-banner" data-testid="win-banner">
            <span>{banner}</span>
          </div>
        ) : null}

        {/* Static hexagon body */}
        <div className="stage-hex">
          <svg width={620} height={600} aria-hidden="true">
            <polygon
              points={GEO.hexPts}
              fill="none"
              stroke="var(--hex-stroke)"
              strokeWidth="1.6"
            />
          </svg>

          {/* Dot lattice */}
          {GEO.dots.map((dot) => {
            const info = revealDots[dot.key];
            const launch = flyMap[dot.key];
            let anim = "none";
            if (info) {
              anim = reveal?.clearing
                ? "symbolFadeOut .65s ease-in forwards"
                : launch === undefined
                  ? `symbolPop .36s cubic-bezier(.17,.89,.32,1.28) forwards ${info.delay}s`
                  : `symbolFadeOut .18s ease-in forwards ${launch}s`;
            }
            return (
              <div
                key={dot.key}
                className="dot-cell"
                style={{ left: dot.x, top: dot.y }}
              >
                {info ? (
                  <div className="dot-symbol" style={{ animation: anim }}>
                    <Textile sym={info.sym} />
                  </div>
                ) : (
                  <div className="dot-untouched" />
                )}
              </div>
            );
          })}

          {/* Central honeycomb core: the reveal wins over the phase, since
              the result usually lands before ends_at while the phase still
              says "locked", and the next round can open mid-reveal. Through
              the build-up the live core stays and shakes; it explodes once
              the reveal has fired. */}
          {reveal?.fired ? (
            // The core detonates at the fire instant; coreHexExplode ends at
            // opacity 0 and holds there ("forwards") for the rest of the
            // reveal. Keyed on the reveal so a queued second reveal restarts it.
            <div
              key={reveal.key}
              className="stage-core"
              style={{
                left: GEO.cx,
                top: GEO.cy,
                animation: "coreHexExplode .9s ease-out forwards",
              }}
            >
              <LogoCog size={72} />
            </div>
          ) : reveal || coreLive ? (
            <div
              className="stage-core"
              style={{
                left: GEO.cx,
                top: GEO.cy,
                animation: coreEnter
                  ? "coreFadeIn .85s ease-out forwards"
                  : shake,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <LogoCog size={72} />
              </div>
            </div>
          ) : null}

          {/* Laser, from the fire instant */}
          {reveal?.fired ? (
            <svg
              width={620}
              height={600}
              className="stage-laser"
              aria-hidden="true"
            >
              <path
                d={reveal.laser.pathD}
                pathLength={100}
                fill="none"
                stroke="var(--accent-text)"
                strokeWidth="3.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle r={4.5} fill="var(--accent-text)">
                <animateMotion
                  dur="0.9s"
                  fill="freeze"
                  path={reveal.laser.pathD}
                />
              </circle>
            </svg>
          ) : null}

          {/* 36 tiles */}
          {GEO.tiles.map((tile) => {
            const isWin = winDisplay === tile.n;
            const isSel = selectedSet.has(tile.n);
            const cls = [
              "tile-cell",
              isWin ? "tile-winner" : "",
              isSel ? "tile-selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={tile.n}
                className={cls}
                data-testid={`tile-${tile.n - 1}`}
                data-selected={isSel ? "1" : "0"}
                style={{
                  left: tile.x,
                  top: tile.y,
                  transform: `rotate(${tile.rot}deg)`,
                }}
                onClick={() => canPick && onToggleTile(tile.n)}
              >
                <div className="tile-face">
                  <span
                    style={{
                      transform: `rotate(${-tile.rot}deg)`,
                      display: "block",
                    }}
                  >
                    {tile.n}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Victory shockwaves */}
          {reveal && reveal.boom ? (
            <>
              <div
                className="shock-ring"
                style={{
                  left: GEO.tiles[reveal.winningTile]!.x,
                  top: GEO.tiles[reveal.winningTile]!.y,
                }}
              />
              <div
                className="shock-ring alt"
                style={{
                  left: GEO.tiles[reveal.winningTile]!.x,
                  top: GEO.tiles[reveal.winningTile]!.y,
                }}
              />
            </>
          ) : null}
        </div>

        <RoundPotPill value={pot} />
      </div>

      {/* Game gate (ticket 02, feature-gates): covers the board instead of
          consulting idleLabel; the label sits underneath, blurred out. */}
      {GAME_GATED ? <ComingSoon /> : null}

      {/* Round win takeover */}
      {takeover ? (
        <div
          className="takeover"
          data-testid="takeover"
          data-title={takeover.title}
          onClick={dismissTakeover}
        >
          <div className="takeover-shock" />
          <div className="takeover-title">{takeover.title}</div>
          <div className="takeover-amount" data-testid="takeover-amount">
            {takeover.amount}
          </div>
          <div className="takeover-tile">{takeover.tileText}</div>
        </div>
      ) : null}
    </div>
  );
}
