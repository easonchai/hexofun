/**
 * Fixed phone bar showing the stake bar model (`stakeBar.ts`) and opening
 * the bet drawer. One labelled button — spec.md "Stake bar": "It is one
 * button." Rendered unconditionally on the MINE tab; CSS hides it above
 * 960px (spec.md "Breakpoint": no JS breakpoint logic for this element).
 */
import type { Phase, PositionLike } from "../engine.js";
import { stakeBarModel } from "./stakeBar.js";

type Props = {
  stakeText: string;
  selected: number[];
  position: PositionLike | null;
  phase: Phase;
  decimals: number;
  onOpen: () => void;
};

export function StakeBarButton({
  stakeText,
  selected,
  position,
  phase,
  decimals,
  onOpen,
}: Props) {
  const model = stakeBarModel(stakeText, selected, position, phase, decimals);
  const ariaLabel = `Stake bar: ${model.ticketsPerTile} tickets per tile, ${model.tilesSelected} tiles selected, ${model.ticketsIn} tickets in. ${model.label}.`;

  return (
    <button
      type="button"
      className="stake-bar"
      data-testid="stake-bar"
      data-state={model.state}
      aria-label={ariaLabel}
      onClick={onOpen}
    >
      <span className="stake-bar-stats">
        <span className="stake-bar-stat">
          <span className="stake-bar-stat-label">AMOUNT</span>
          <span className="stake-bar-stat-value" data-testid="stake-bar-per-tile">
            {model.ticketsPerTile}
          </span>
        </span>
        <span className="stake-bar-stat">
          <span className="stake-bar-stat-label">TICKETS IN</span>
          <span className="stake-bar-stat-value" data-testid="stake-bar-tickets-in">
            {model.ticketsIn}
          </span>
        </span>
        <span className="stake-bar-stat">
          <span className="stake-bar-stat-label">TILES</span>
          <span className="stake-bar-stat-value" data-testid="stake-bar-tiles">
            {model.tilesSelected}
          </span>
        </span>
      </span>
      <span className={`stake-bar-cta stake-bar-cta-${model.state}`}>
        {model.state === "placed" ? (
          <span className="stake-bar-placed-mark" aria-hidden="true">
            ✓
          </span>
        ) : null}
        {model.label}
      </span>
    </button>
  );
}
