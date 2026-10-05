/**
 * DASHBOARD tab (the Figma "Dashboard" frame, node 249:8): where EARN lands.
 * Two halftone cards — your principal on the left, today's prize and the
 * draw clock on the right — then the odds strip, past winners and your own
 * account history.
 *
 * The deposit widget lives one hop further in (VAULT): the two buttons on the
 * left card are the only way to reach it, each carrying which tab it opens on.
 *
 * Ticket 07: `currentEpoch` and `player` come from App's one `GET /state`
 * poll instead of two duplicate polls of this screen's own. Epoch history,
 * account history and the winners' rounds-played chip stay on their own
 * slower polls — list data, not live state.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import {
  apiBaseUrl,
  fetchEpochs,
  fetchFeed,
  fetchPositionCounts,
  type CurrentEpochDto,
  type EpochDto,
  type EventDto,
  type PlayerDto,
} from "../api.js";
import { CLUSTER, GAME_GATED, JACKPOT_GATED, eventKey } from "../chain.js";
import { dhmsParts } from "../engine.js";
import { launchCountdown, launchCountdownLabel, prizeCardState } from "../launch.js";
import { formatAddress, formatMoney2 } from "../lib/money.js";
import { useApiPoll } from "../useApiPoll.js";
import { Star, wholeDollars } from "./Home.js";

const DECIMALS = 6;
const SYMBOL = "USDC";
const CLOCK_LABELS = ["DAYS", "HRS", "MIN", "SEC"] as const;
/** Mainnet is the explorer's default; every other cluster needs the query. */
const txExplorerUrl = (signature: string) =>
  `https://explorer.solana.com/tx/${signature}${
    CLUSTER === "devnet" ? "?cluster=devnet" : ""
  }`;

/** Atomic (6dp) string → "$2,423.55". */
const dollars = (atomic: string) =>
  `$${formatMoney2(BigInt(atomic.replace(/[^0-9]/g, "") || "0"), DECIMALS)}`;

/** The 13px "open in new tab" glyph after each tx hash in the Figma rows. */
const NewTab = () => (
  <svg
    viewBox="0 0 13 13"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5.5 2.5H2.5v8h8V7.5M7.5 2.5h3v3M10.5 2.5 6 7" />
  </svg>
);
/** Rollovers leave `winner: null`, so look back further than 5 to find five. */
const EPOCH_LOOKBACK = 20;
const WINNERS_SHOWN = 5;
/** History starts at a glance and opens to a page on "view all". */
const HISTORY_ROWS = 5;
const HISTORY_ROWS_EXPANDED = 50;

export interface DashboardScreenProps {
  owner: PublicKey | null;
  principal: bigint;
  entries: bigint;
  /** Chain clock seconds, for the draw countdown. */
  now: bigint | null;
  currentEpoch: CurrentEpochDto | null;
  /** Ticket 05: `/state`'s `launchAt`, present only while `currentEpoch` is
   *  null (the deposit-only launch week). */
  launchAt: string | null;
  /** game-jackpot-pause: the draw is held, so the clock says so instead of
   *  counting to a draw that will not run on schedule. */
  jackpotPaused: boolean;
  /** Null until the owner's Player is indexed, or no wallet is connected. */
  player: PlayerDto | null;
  onDeposit: () => void;
  onWithdraw: () => void;
  onPlay: () => void;
  onViewDraws: () => void;
}

/** Unix seconds (decimal string) → "Sun, Sep 6". Exported for referrals.ts's
 *  Your Team JOINED column (referral-page ticket 05), which wants the exact
 *  same format. */
export function shortDate(unixSeconds: string | null): string {
  if (unixSeconds === null) return "—";
  const ms = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

interface HistoryRow {
  key: string;
  label: string;
  signature: string;
  amount: string;
  blockTime: string | null;
  /** Prize rows read lime across the row; deposits and withdrawals do not. */
  prize: boolean;
}

/**
 * The three event kinds an account statement cares about. Everything else the
 * feed carries (positions, rounds, rollovers) belongs to the game, not the
 * money path, so it is dropped rather than shown with a blank amount.
 */
function toHistoryRow(row: EventDto): HistoryRow | null {
  const data = row.data ?? {};
  const amount = dollars(String(data.amount ?? "0"));
  const key = `${row.slot}-${row.signature}-${row.index}`;
  switch (eventKey(row.name)) {
    case "deposited":
      return {
        key,
        label: "Deposit",
        signature: row.signature,
        amount: `+ ${amount}`,
        blockTime: row.blockTime,
        prize: false,
      };
    case "withdrawn":
      return {
        key,
        label: "Withdraw",
        signature: row.signature,
        amount: `- ${amount}`,
        blockTime: row.blockTime,
        prize: false,
      };
    case "jackpotPaid":
      return {
        key,
        label: "Prize Win",
        signature: row.signature,
        amount,
        blockTime: row.blockTime,
        prize: true,
      };
    default:
      return null;
  }
}

export function Dashboard(props: DashboardScreenProps) {
  const {
    owner,
    principal,
    entries,
    now,
    currentEpoch,
    launchAt,
    jackpotPaused,
    player,
    onDeposit,
    onWithdraw,
    onPlay,
    onViewDraws,
  } = props;
  const ownerBase58 = owner?.toBase58();
  const fmt2 = (value: bigint) => formatMoney2(value, DECIMALS);

  const [historyOpen, setHistoryOpen] = useState(false);
  const historyLimit = historyOpen ? HISTORY_ROWS_EXPANDED : HISTORY_ROWS;

  const loadEpochs = useCallback(
    (signal: AbortSignal) => fetchEpochs(apiBaseUrl(), EPOCH_LOOKBACK, signal),
    [],
  );
  const loadHistory = useCallback(
    (signal: AbortSignal) =>
      ownerBase58
        ? // Over-fetch: the feed carries game events too, and only the three
          // money ones survive toHistoryRow.
          fetchFeed(apiBaseUrl(), historyLimit * 4, signal, ownerBase58)
        : Promise.resolve({ ok: false as const, reason: "no wallet connected" }),
    [ownerBase58, historyLimit],
  );

  const epochs = useApiPoll(loadEpochs, 10_000);
  const history = useApiPoll(loadHistory, 10_000);

  const winners = useMemo(
    () =>
      (epochs.data ?? [])
        .filter((row): row is EpochDto & { winner: string } => row.winner !== null)
        .slice(0, WINNERS_SHOWN),
    [epochs.data],
  );

  const historyRows = useMemo(() => {
    const out: HistoryRow[] = [];
    for (const row of history.data ?? []) {
      const mapped = toHistoryRow(row);
      if (mapped) out.push(mapped);
    }
    return out.slice(0, historyLimit);
  }, [history.data, historyLimit]);

  // Rounds played per winner, for the chip beside each Past Winners row. One
  // batched call for the whole table, refreshed only when the addresses change.
  const [roundsPlayed, setRoundsPlayed] = useState<Record<string, number>>({});
  const winnerKey = winners.map((row) => row.winner).join(",");
  useEffect(() => {
    if (winnerKey === "") {
      setRoundsPlayed({});
      return;
    }
    const controller = new AbortController();
    void (async () => {
      const result = await fetchPositionCounts(
        apiBaseUrl(),
        winnerKey.split(","),
        controller.signal,
      );
      if (result.ok) setRoundsPlayed(result.data.counts);
    })();
    return () => controller.abort();
  }, [winnerKey]);

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

  // Principal drops the moment a withdrawal is requested and the USDC lands a
  // day later, so the card says where the difference went.
  const pendingWithdraw = player ? BigInt(player.pendingWithdraw) : 0n;
  // Odds need the pool-wide weight denominator, so they only exist once the
  // backend knows this wallet. Before the first deposit the whole strip goes.
  const showBoost = entries > 0n;

  const apiError = epochs.error;

  return (
    <div className="screen-dash" data-testid="dashboard-screen">
      <div className="dash-cards">
        <section className="dash-card dash-card-principal">
          <h2 className="dash-card-title">Your Principal</h2>
          <div className="dash-principal" data-testid="dash-principal">
            ${fmt2(principal)}
          </div>
          <dl className="dash-card-lines">
            <div>
              <dt>Ticket</dt>
              <dd data-testid="dash-tickets">
                {(entries / 10n ** BigInt(DECIMALS)).toLocaleString("en-US")}
              </dd>
            </div>
            {pendingWithdraw > 0n ? (
              <div>
                <dt>Withdrawing</dt>
                <dd data-testid="dash-pending-withdraw">
                  ${fmt2(pendingWithdraw)}
                </dd>
              </div>
            ) : null}
          </dl>
          <div className="dash-card-actions">
            <button
              type="button"
              className="dash-btn dash-btn-wide"
              data-testid="dash-deposit"
              onClick={onDeposit}
            >
              + Deposit More
            </button>
            <button
              type="button"
              className="dash-btn"
              data-testid="dash-withdraw"
              disabled={principal === 0n}
              onClick={onWithdraw}
            >
              Withdraw
            </button>
          </div>
        </section>

        <section className="dash-card dash-card-prize">
          <div className="dash-prize-heading">
            <Star />
            <span className="dash-prize-label">DAILY PRIZE POOL</span>
            <Star />
          </div>
          <div className="dash-prize" data-testid="dash-prize">
            {currentEpoch ? wholeDollars(currentEpoch.jackpotAmount) : "$—"}
          </div>
          <div className="dash-clock-label">NEXT DRAW IN</div>
          {cardState === "launch" ? (
            <div className="dash-drawing" data-testid="dash-launch-countdown">
              {launchLabel}
            </div>
          ) : cardState === "paused" ? (
            <div className="dash-drawing" data-testid="dash-draw-paused">
              DRAW PAUSED
            </div>
          ) : drawing || (remaining !== null && remaining <= 0n) ? (
            <div className="dash-drawing" data-testid="dash-drawing">
              DRAWING…
            </div>
          ) : (
            <div className="dash-clock" data-testid="dash-countdown">
              {CLOCK_LABELS.map((label, i) => (
                <div key={label} className="dash-clock-unit">
                  <span className="dash-clock-value">
                    <span>{parts ? parts[i] : "--"}</span>
                  </span>
                  <span className="dash-clock-unit-label">{label}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {showBoost ? (
        <section className="dash-boost" data-testid="dash-boost">
          <div className="dash-boost-copy">
            <h3 className="dash-boost-title">
              <Star />
              <span>
                Your Odds:{" "}
                <span className="dash-lime">
                  {player?.odds != null ? `${player.odds}%` : "—"}
                </span>
              </span>
            </h3>
            <p>
              Use your tickets to play in games that boost your odds. Your
              principal is never touched.
            </p>
          </div>
          <button
            type="button"
            className="dash-boost-cta"
            data-testid="dash-play"
            // Same aria-disabled + data-tip treatment as the PLAY nav tab
            // (App.tsx) under the game gate (ticket 01, feature-gates).
            aria-disabled={GAME_GATED}
            data-tip={GAME_GATED ? "Coming soon" : undefined}
            onClick={GAME_GATED ? undefined : onPlay}
          >
            Play to boost
            <svg
              viewBox="0 0 20 20"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 16 16 4M7 4h9v9" />
            </svg>
          </button>
        </section>
      ) : null}

      <section className="dash-panel">
        <h2 className="dash-panel-title">Past Winners</h2>
        {winners.length === 0 ? (
          <p className="screen-copy">no daily draw has paid a winner yet.</p>
        ) : (
          <div
            className="board-list board-list-4col dash-winners"
            data-testid="dash-winner-rows"
          >
            <div className="board-row board-head">
              <span>DRAW</span>
              <span>WINNER ADDRESS</span>
              <span>PRIZE ({SYMBOL})</span>
              <span>DATE</span>
            </div>
            {winners.map((row) => (
              <div className="board-row" key={row.id}>
                <span className={row.winner === ownerBase58 ? "dash-lime" : "dash-dim"}>
                  #{row.id}
                </span>
                <span className="dash-addr">
                  {row.winner === ownerBase58 ? "You" : formatAddress(row.winner)}
                  {/* The backend answers 0 for a winner who never played a
                      round; a "Played 0 rounds" chip is noise, so it goes. */}
                  {(roundsPlayed[row.winner] ?? 0) > 0 ? (
                    <span className="dash-chip">
                      Played {roundsPlayed[row.winner]}{" "}
                      {roundsPlayed[row.winner] === 1 ? "round" : "rounds"}
                    </span>
                  ) : null}
                </span>
                <span className="dash-lime">{dollars(row.jackpotAmount)}</span>
                <span className="dash-date">{shortDate(row.endsAt)}</span>
              </div>
            ))}
          </div>
        )}
        <button type="button" className="dash-more" onClick={onViewDraws}>
          → View all draws
        </button>
      </section>

      <section className="dash-panel">
        <h2 className="dash-panel-title">Account History</h2>
        {!ownerBase58 ? (
          <p className="screen-copy">connect a wallet to see your history.</p>
        ) : historyRows.length === 0 ? (
          <p className="screen-copy">no deposits, withdrawals or prizes yet.</p>
        ) : (
          <div
            className="board-list board-list-4col dash-history"
            data-testid="dash-history-rows"
          >
            <div className="board-row board-head">
              <span>TYPE</span>
              <span>TX HASH</span>
              <span>ACCOUNT ({SYMBOL})</span>
              <span>DATE</span>
            </div>
            {historyRows.map((row) => (
              <div className="board-row" key={row.key}>
                <span className={row.prize ? "dash-lime" : "dash-dim"}>{row.label}</span>
                <span className="dash-addr">
                  <a
                    className="dash-tx"
                    href={txExplorerUrl(row.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {formatAddress(row.signature)}
                    <NewTab />
                  </a>
                </span>
                <span className={row.prize ? "dash-lime" : undefined}>{row.amount}</span>
                <span className="dash-date">{shortDate(row.blockTime)}</span>
              </div>
            ))}
          </div>
        )}
        {historyRows.length > 0 && !historyOpen ? (
          <button
            type="button"
            className="dash-more"
            data-testid="dash-history-more"
            onClick={() => setHistoryOpen(true)}
          >
            → View all history
          </button>
        ) : null}
      </section>

      {apiError ? <div className="screen-note err">{apiError}</div> : null}
    </div>
  );
}
