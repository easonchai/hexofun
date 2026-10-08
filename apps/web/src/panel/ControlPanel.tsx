/**
 * Right control panel — port of the prototype's three tiers: amount/tile
 * config, cost summary + kinetic DEPLOY CTA, and round telemetry/feed.
 */
import { useState } from "react";

import { Textile } from "../arena/Textile.js";
import { formatAtomic, formatAtomic2, parseAtomic } from "../lib/money.js";
import type { EngineOutput } from "../useRoundEngine.js";
import type { FeedRow } from "../engine.js";
import { PanelCard } from "../ui.js";

const SYMBOL_ROW = [0, 1, 2, 3, 4, 5];

/** Phone drawer tabs. `deposit` = tiers 1+2, `lastwin` = tier 3. */
export type PanelTab = "deposit" | "lastwin";

export interface ControlPanelProps {
  /** Omitted (desktop) renders every tier stacked. */
  tab?: PanelTab;
  engine: EngineOutput;
  /** The Player's Tickets, atomic units. */
  tickets: bigint;
  decimals: number;
  stakeText: string;
  setStakeText: (value: string) => void;
  autoRounds: number;
  setAutoRounds: (value: number) => void;
  canDeploy: boolean;
  deployProblems: string[];
  /** Why the deploy button is idle (round state); shown as its tooltip. */
  deployHint: string | null;
  deployBusy: boolean;
  deployNote: string | null;
  locked: boolean;
  deployedTotal: bigint;
  lastWin: { tile: number; kind: string } | null;
  feed: FeedRow[];
  onDeploy: () => void;
}

export function ControlPanel(props: ControlPanelProps) {
  const {
    tab,
    engine,
    tickets,
    decimals,
    stakeText,
    setStakeText,
    autoRounds,
    setAutoRounds,
    canDeploy,
    deployProblems,
    deployHint,
    deployBusy,
    deployNote,
    locked,
    deployedTotal,
    lastWin,
    feed,
    onDeploy,
  } = props;

  const tiles = engine.selected.length;
  const stake = parseAtomic(stakeText, decimals) ?? 0n;
  const perRound = stake * BigInt(Math.max(tiles, 0));
  // The manual deploy plays one round; auto-rounds adds that many more.
  const rounds = autoRounds + 1;
  const fmt = (value: bigint) => formatAtomic2(value, decimals);

  const addAmount = (delta: number): void => {
    const current = stake;
    const next = current + BigInt(delta) * 10n ** BigInt(decimals);
    setStakeText(formatAtomic(next, decimals));
  };

  const setMax = (): void => {
    if (tiles === 0) return;
    setStakeText(formatAtomic(tickets / BigInt(tiles), decimals));
  };

  const togglePreset = (kind: "odd" | "even" | "all"): void => {
    const wanted =
      kind === "all"
        ? Array.from({ length: 36 }, (_, i) => i + 1)
        : Array.from({ length: 18 }, (_, i) =>
            kind === "odd" ? i * 2 + 1 : (i + 1) * 2,
          );
    const isSame =
      engine.selected.length === wanted.length &&
      wanted.every((tile) => engine.selected.includes(tile));
    engine.setSelected(isSame ? [] : wanted);
  };

  const presetActive = (kind: "odd" | "even" | "all"): boolean => {
    const wanted = kind === "all" ? 36 : 18;
    if (engine.selected.length !== wanted) return false;
    return engine.selected.every((tile) =>
      kind === "all" ? true : kind === "odd" ? tile % 2 === 1 : tile % 2 === 0,
    );
  };

  const pickRandomTile = (): void => {
    const unpicked: number[] = [];
    for (let n = 1; n <= 36; n += 1)
      if (!engine.selected.includes(n)) unpicked.push(n);
    if (unpicked.length > 0)
      engine.setSelected([
        ...engine.selected,
        unpicked[Math.floor(Math.random() * unpicked.length)]!,
      ]);
  };

  const ready = canDeploy && tiles > 0 && stake > 0n && !locked && !deployBusy;
  const showScan = ready && !locked;
  const showLocked = locked && !deployBusy;

  /** Prototype deploy burst: six symbols radiating out for 0.65s. */
  const [burst, setBurst] = useState(false);
  const fireDeploy = (): void => {
    if (!ready) return;
    setBurst(true);
    window.setTimeout(() => setBurst(false), 650);
    onDeploy();
  };

  const showDeposit = tab !== "lastwin";
  const showLastWin = tab !== "deposit";

  return (
    <aside className="control-panel" data-testid="control-panel">
      {showDeposit ? (
      <>
      {/* TIER 1 — amount / tiles / auto-rounds */}
      <PanelCard
        title="AMOUNT / TILE"
        aside={
          <span
            className="panel-reset"
            role="button"
            data-testid="stake-reset"
            onClick={() => setStakeText("0")}
          >
            RESET
          </span>
        }
      >
        <div className="volt-banner">
          <input
            value={stakeText}
            placeholder="0.00"
            onChange={(event) =>
              setStakeText(event.target.value.replace(/[^0-9.]/g, ""))
            }
            inputMode="decimal"
            data-testid="stake-input"
            aria-label="Stake per tile"
          />
        </div>

        <div className="dual-line" style={{ justifyContent: "flex-end" }}>
          <span data-testid="wallet-tickets">Tickets {fmt(tickets)}</span>
        </div>

        <div className="quick-row">
          <span className="pill" role="button" onClick={() => addAmount(1)}>
            +1
          </span>
          <span className="pill" role="button" onClick={() => addAmount(5)}>
            +5
          </span>
          <span className="pill" role="button" onClick={() => addAmount(10)}>
            +10
          </span>
          <span className="pill max" role="button" onClick={setMax}>
            MAX
          </span>
        </div>

        <div className="row-line">
          <span className="row-label">TILES</span>
          <div className="row-controls">
            <div className="presets">
              <span
                className={`preset${presetActive("odd") ? " active" : ""}`}
                role="button"
                onClick={() => togglePreset("odd")}
              >
                ODD
              </span>
              <span
                className={`preset${presetActive("even") ? " active" : ""}`}
                role="button"
                onClick={() => togglePreset("even")}
              >
                EVEN
              </span>
              <span
                className={`preset${presetActive("all") ? " active" : ""}`}
                role="button"
                onClick={() => togglePreset("all")}
              >
                1-36
              </span>
            </div>
            <div className="stepper">
              <span
                className="step-btn"
                role="button"
                data-testid="tile-minus"
                onClick={() => engine.setSelected(engine.selected.slice(0, -1))}
              >
                −
              </span>
              <span className="step-num" data-testid="tile-count">
                {tiles}
              </span>
              <span
                className="step-btn"
                role="button"
                data-testid="tile-plus"
                onClick={pickRandomTile}
              >
                +
              </span>
            </div>
          </div>
        </div>

        <div className="row-line">
          <span className="row-label">AUTO-ROUNDS</span>
          <div className="row-controls">
            <div className="stepper">
              <span
                className="step-btn"
                role="button"
                onClick={() => setAutoRounds(Math.max(0, autoRounds - 1))}
              >
                −
              </span>
              <span className="step-num" data-testid="auto-rounds">
                {autoRounds}
              </span>
              <span
                className="step-btn"
                role="button"
                onClick={() => setAutoRounds(Math.min(99, autoRounds + 1))}
              >
                +
              </span>
            </div>
          </div>
        </div>
      </PanelCard>

      {/* TIER 2 — cost summary + deploy CTA */}
      <PanelCard>
        <div className="cost-row">
          <span className="row-label">PER ROUND</span>
          <div>
            <span className="cost-value">{fmt(perRound)}</span>
            <span className="cost-unit"> Tickets</span>
          </div>
        </div>
        <div className="cost-row">
          <span className="row-label">TICKETS IN ({rounds} {rounds === 1 ? "ROUND" : "ROUNDS"})</span>
          <div>
            <span className="volt-badge" data-testid="total-cost">
              {fmt(perRound * BigInt(rounds))}
            </span>
            <span className="cost-unit"> Tickets</span>
          </div>
        </div>
        <div className="cost-row deployed">
          <span className="row-label strong">IN THIS ROUND</span>
          <span className="cost-value" data-testid="deployed-total">
            {fmt(deployedTotal)}
          </span>
        </div>
        {deployProblems.length > 0 ? (
          <div className="problems" data-testid="deploy-problems">
            {deployProblems.map((problem) => (
              <div key={problem} className="problem">
                {problem}
              </div>
            ))}
          </div>
        ) : null}

        <button
          type="button"
          className={`btn-deploy${locked ? " locked" : ""}${!canDeploy || tiles === 0 || stake === 0n ? " dim" : ""}`}
          data-testid="deploy"
          disabled={!ready}
          title={deployHint ?? undefined}
          onClick={fireDeploy}
        >
          {burst ? (
            <div className="deploy-burst">
              {SYMBOL_ROW.map((sym) => (
                <div
                  key={sym}
                  style={{
                    animation: `burst${sym} .6s cubic-bezier(.15,.85,.25,1) forwards`,
                  }}
                >
                  <Textile sym={sym} size={14} />
                </div>
              ))}
            </div>
          ) : null}
          {deployBusy ? (
            <span>SIGNING…</span>
          ) : showLocked ? (
            <span className="deploy-locked">
              <span className="slot-box">
                {SYMBOL_ROW.map((sym) => (
                  <span key={sym} className="slot">
                    <Textile sym={sym} size={14} />
                  </span>
                ))}
              </span>
              DEPLOYED
            </span>
          ) : showScan ? (
            <span className="deploy-ready">
              <span>DEPLOY</span>
              <span className="cyc-row">
                {SYMBOL_ROW.map((sym) => (
                  <span key={sym} className="cyc">
                    <Textile sym={sym} size={10} />
                  </span>
                ))}
              </span>
            </span>
          ) : (
            <span>{tiles === 0 ? "SELECT TILES" : locked ? "DEPLOYED" : "DEPLOY"}</span>
          )}
        </button>
        {deployNote ? (
          <div className="panel-note" data-testid="deploy-note">
            {deployNote}
          </div>
        ) : null}
      </PanelCard>
      </>
      ) : null}

      {/* TIER 3 — telemetry + feed */}
      {showLastWin ? (
      <PanelCard>
        {lastWin ? (
          <div className="lastwin-banner" data-testid="lastwin-banner">
            <div className="lastwin-left">
              <span className="row-label">LAST WIN</span>
              <span className="lastwin-tile">⬡ {lastWin.tile}</span>
              <span className="lastwin-kind">{lastWin.kind}</span>
            </div>
            <span className="lastwin-dot" aria-hidden="true" />
          </div>
        ) : null}
        <div className="feed-head">
          <span className="feed-title">LIVE MINERS</span>
          <span className="feed-sub">POOL STREAM</span>
        </div>
        <div className="feed" data-testid="miner-feed">
          {feed.length === 0 ? (
            <div className="feed-empty">waiting for pool activity…</div>
          ) : (
            feed.slice(0, 10).map((row) => (
              <div key={row.key} className="feed-row">
                <span className="feed-who">{row.who}</span>
                <span className="feed-action">{row.action}</span>
                <span className="feed-tiles">{row.tileLabel}</span>
              </div>
            ))
          )}
        </div>
      </PanelCard>
      ) : null}
    </aside>
  );
}
