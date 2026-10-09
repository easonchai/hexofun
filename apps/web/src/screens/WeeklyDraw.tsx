/**
 * DAILY DRAW tab: the epoch's yield as today's prize, on the
 * tab ticket 10 emptied out when it deleted the old EXPLORE screen. Everything
 * here is aggregate state from the API (epoch, prize amount, your Tickets and
 * odds, the pool total, past winners). It sends nothing on chain: every
 * Player is in the draw, so there is nothing to register.
 *
 * "Epoch" stays the mechanism name in code and the API; on screen it is a
 * day (ticket 14, renamed from a week by the epoch-anchor effort).
 *
 * Ticket 07: `currentEpoch` and `player` come from App's one `GET /state`
 * poll instead of two duplicate polls of this screen's own; epoch history
 * stays on its own slower poll (list data).
 */
import { useCallback, useMemo } from "react";
import type { PublicKey } from "@solana/web3.js";

import { atomicShort } from "../activityRows.js";
import { apiBaseUrl, fetchEpochs, type CurrentEpochDto, type EpochDto, type PlayerDto } from "../api.js";
import { hmText } from "../engine.js";
import { prizeShown } from "../launch.js";
import { formatAddress } from "../lib/money.js";
import { PanelCard, Stat, StatGrid } from "../ui.js";
import { useApiPoll } from "../useApiPoll.js";
import { useLivePool } from "../useLiveYield.js";

const SYMBOL = "USDC";
/** Rollovers leave `winner: null`, so look back further than 5 to find five. */
const EPOCH_LOOKBACK = 20;
const WINNERS_SHOWN = 5;

export interface WeeklyDrawScreenProps {
  owner: PublicKey | undefined;
  /** Chain clock seconds, for the draw countdown. */
  now: bigint | null;
  currentEpoch: CurrentEpochDto | null;
  /** game-jackpot-pause: the draw is held; the header says so. */
  jackpotPaused: boolean;
  /** Null until the owner's Player is indexed, or no wallet is connected. */
  player: PlayerDto | null;
}

export function WeeklyDraw(props: WeeklyDrawScreenProps) {
  const { owner, now, currentEpoch, jackpotPaused, player } = props;
  const ownerBase58 = owner?.toBase58();

  const loadEpochs = useCallback(
    (signal: AbortSignal) => fetchEpochs(apiBaseUrl(), EPOCH_LOOKBACK, signal),
    [],
  );

  const history = useApiPoll(loadEpochs, 10_000);

  const winners = useMemo(
    () =>
      (history.data ?? [])
        .filter((row): row is EpochDto & { winner: string } => row.winner !== null)
        .slice(0, WINNERS_SHOWN),
    [history.data],
  );

  const countdown =
    currentEpoch && now !== null
      ? hmText(BigInt(currentEpoch.endsAt) - now)
      : "--:--";
  const drawing = currentEpoch?.drawing ?? null;

  const poolTotal = useLivePool()?.pool.totalPrincipal;

  const apiError = history.error;

  return (
    <div className="screen-vault" data-testid="daily-draw-screen">
      <PanelCard
        wide
        title="DAILY DRAW"
        aside={
          <span className="dual-line-inline" data-testid="draw-header-clock">
            {jackpotPaused ? "draw paused" : `draw in ${countdown}`}
          </span>
        }
      >
        <p className="screen-copy">
          Today's prize is the yield above what depositors earn, paid in full
          to one winner. Every deposit is in the draw. Your odds are your
          share of the day's Tickets at the draw, assuming nobody deposits,
          withdraws or plays before then.
        </p>
        <StatGrid>
          <Stat
            label="Prize"
            value={
              currentEpoch ? `${atomicShort(prizeShown(currentEpoch))} ${SYMBOL}` : "—"
            }
            testid="prize-amount"
          />
          <Stat
            label="Your tickets"
            value={
              player
                ? player.weight === null
                  ? "—"
                  : atomicShort(player.weight)
                : ownerBase58
                  ? "—"
                  : "connect a wallet"
            }
            testid="your-weight"
          />
          <Stat
            label="Your odds"
            value={player?.odds != null ? `${player.odds}%` : "—"}
            testid="your-odds"
          />
          <Stat
            label="Pool principal"
            value={poolTotal === undefined ? "—" : `${atomicShort(poolTotal)} ${SYMBOL}`}
            testid="pool-total"
          />
          <Stat label="Day" value={currentEpoch ? `#${currentEpoch.id}` : "—"} small />
        </StatGrid>
      </PanelCard>

      {drawing ? (
        <PanelCard wide title={`DRAWING DAY ${drawing.epochId}`}>
          <p className="screen-copy">
            The draw for day {drawing.epochId} is under way. Every deposit is
            already in it.
          </p>
        </PanelCard>
      ) : null}

      <PanelCard wide title="LAST WINNERS">
        {winners.length === 0 ? (
          <p className="screen-copy">no daily draw has paid a winner yet.</p>
        ) : (
          <div className="board-list" data-testid="winner-rows">
            {winners.map((row) => (
              <div className="board-row" key={row.id}>
                <span>day #{row.id}</span>
                <span>
                  {row.winner === ownerBase58
                    ? "You, added to your Principal"
                    : formatAddress(row.winner)}
                </span>
                <span>
                  {atomicShort(row.jackpotAmount)} {SYMBOL}
                </span>
              </div>
            ))}
          </div>
        )}
      </PanelCard>

      {apiError ? <div className="screen-note err">{apiError}</div> : null}
    </div>
  );
}
