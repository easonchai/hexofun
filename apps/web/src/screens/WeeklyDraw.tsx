/**
 * DAILY DRAW tab: the epoch's yield as today's prize, on the
 * tab ticket 10 emptied out when it deleted the old EXPLORE screen. Everything
 * here is aggregate state from the API (epoch, prize amount, your weight and
 * odds, past winners). `register` is the one on-chain write it sends, and
 * only as the permissionless fallback PRD §3.3 describes.
 *
 * "Epoch" stays the mechanism name in code and the API; on screen it is a
 * day (ticket 14, renamed from a week by the epoch-anchor effort).
 *
 * Ticket 07: `currentEpoch` and `player` come from App's one `GET /state`
 * poll instead of two duplicate polls of this screen's own; epoch history
 * stays on its own slower poll (list data). `onDone` tightens the state poll
 * (`useStatePoll.ts` `kick`) instead of triggering a chain re-read.
 */
import { useCallback, useMemo, useState } from "react";
import type { PublicKey } from "@solana/web3.js";

import { atomicShort } from "../activityRows.js";
import { awaitSendResult, register, type TxSigner } from "../actions.js";
import { apiBaseUrl, fetchEpochs, type CurrentEpochDto, type EpochDto, type PlayerDto } from "../api.js";
import type { HexVaultProgram } from "../chain.js";
import { hmText } from "../engine.js";
import { formatAddress } from "../lib/money.js";
import { track } from "../analytics.js";
import { decodePlayerError, decodeSendFailure } from "../playerErrors.js";
import type { PoolLike } from "../read.js";
import { PanelCard, Stat, StatGrid } from "../ui.js";
import { useApiPoll } from "../useApiPoll.js";

const SYMBOL = "USDC";
/** Rollovers leave `winner: null`, so look back further than 5 to find five. */
const EPOCH_LOOKBACK = 20;
const WINNERS_SHOWN = 5;

export interface WeeklyDrawScreenProps {
  program: HexVaultProgram | null;
  owner: PublicKey | undefined;
  /** Sponsored send path of the Privy embedded wallet; unset for the rest. */
  sendTransaction?: TxSigner["sendTransaction"] | undefined;
  pool: PoolLike | null;
  /** Chain clock seconds, for the draw countdown. */
  now: bigint | null;
  currentEpoch: CurrentEpochDto | null;
  /** game-jackpot-pause: the draw is held; the header says so. */
  jackpotPaused: boolean;
  /** Null until the owner's Player is indexed, or no wallet is connected. */
  player: PlayerDto | null;
  onDone: () => void;
}

export function WeeklyDraw(props: WeeklyDrawScreenProps) {
  const { program, owner, sendTransaction, pool, now, currentEpoch, jackpotPaused, player, onDone } = props;
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

  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerNote, setRegisterNote] = useState<string | null>(null);
  const registerMe = useCallback(async () => {
    if (!drawing || !program || !pool || !owner) return;
    setRegisterBusy(true);
    setRegisterNote(null);
    try {
      let result = await register(
        program,
        { publicKey: owner, sendTransaction },
        pool,
        BigInt(drawing.epochId),
      );
      if (result.kind === "unknown") result = await awaitSendResult(program, result);
      if (result.kind !== "landed") {
        setRegisterNote(decodeSendFailure(result));
        return;
      }
      track("draw_registered");
      setRegisterNote("registered your weight for this draw");
      onDone();
    } catch (error) {
      setRegisterNote(decodePlayerError(error));
    } finally {
      setRegisterBusy(false);
    }
  }, [drawing, program, pool, owner, sendTransaction, onDone]);

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
          Today's prize is what the pool's principal earned today, paid in
          full to one winner. Your odds are your share of the day's Weight at
          the draw, assuming nobody deposits, withdraws or plays before then.
        </p>
        <StatGrid>
          <Stat
            label="Prize"
            value={
              currentEpoch ? `${atomicShort(currentEpoch.jackpotAmount)} ${SYMBOL}` : "—"
            }
            testid="prize-amount"
          />
          <Stat
            label="Your weight"
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
          <Stat label="Day" value={currentEpoch ? `#${currentEpoch.id}` : "—"} small />
        </StatGrid>
      </PanelCard>

      {drawing ? (
        <PanelCard wide title={`DRAWING DAY ${drawing.epochId}`}>
          <p className="screen-copy">The draw for day {drawing.epochId} is under way.</p>
          <button
            type="button"
            className="btn-deploy ghost"
            disabled={registerBusy || !program || !pool || !owner}
            data-testid="register-me"
            title={!owner ? "connect a wallet to register" : undefined}
            onClick={() => void registerMe()}
          >
            <span>{registerBusy ? "SIGNING…" : "REGISTER ME"}</span>
          </button>
          {registerNote ? (
            <div className="panel-note" data-testid="register-note">
              {registerNote}
            </div>
          ) : null}
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
