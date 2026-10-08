/**
 * LEADERBOARD tab: top players by Tickets in the current epoch (a day on screen), straight
 * from `GET /leaderboard` (already sorted server-side). Pure read: this
 * screen sends no on-chain instruction.
 */
import { useCallback } from "react";
import type { PublicKey } from "@solana/web3.js";

import { atomicShort } from "../activityRows.js";
import { apiBaseUrl, fetchLeaderboard } from "../api.js";
import { formatAddress } from "../lib/money.js";
import { PanelCard } from "../ui.js";
import { useApiPoll } from "../useApiPoll.js";

const LIMIT = 10;

export interface LeaderboardScreenProps {
  owner: PublicKey | undefined;
}

export function Leaderboard({ owner }: LeaderboardScreenProps) {
  const ownerBase58 = owner?.toBase58();
  const loadLeaderboard = useCallback(
    (signal: AbortSignal) => fetchLeaderboard(apiBaseUrl(), LIMIT, signal),
    [],
  );
  const board = useApiPoll(loadLeaderboard, 10_000);
  const rows = board.data ?? [];

  return (
    <div className="screen-vault" data-testid="leaderboard-screen">
      <PanelCard
        wide
        title="LEADERBOARD"
        aside={
          <span className="dual-line-inline">top {LIMIT} by tickets, today</span>
        }
      >
        {rows.length === 0 ? (
          <p className="screen-copy">no player has any tickets yet.</p>
        ) : (
          <div className="board-list board-list-5col" data-testid="leaderboard-rows">
            <div className="board-row board-head">
              <span>#</span>
              <span>player</span>
              <span>tickets</span>
              <span>in draw</span>
              <span>odds</span>
            </div>
            {rows.map((row, index) => (
              <div
                className={`board-row${row.owner === ownerBase58 ? " board-row-mine" : ""}`}
                key={row.owner}
                data-testid={`leaderboard-row-${index}`}
              >
                <span>{index + 1}</span>
                <span>
                  {row.isHouse
                    ? "House"
                    : row.owner === ownerBase58
                      ? "You"
                      : formatAddress(row.owner)}
                </span>
                <span>{atomicShort(row.tickets)}</span>
                <span>{row.weight === null ? "—" : atomicShort(row.weight)}</span>
                <span>{row.odds === null ? "—" : `${row.odds}%`}</span>
              </div>
            ))}
          </div>
        )}
        {board.error ? (
          <div className="screen-note err" data-testid="leaderboard-error">
            {board.error}
          </div>
        ) : null}
      </PanelCard>
    </div>
  );
}
