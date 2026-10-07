/** Operator-facing copy that more than one panel needs, in one place. */
import type { PauseSwitch } from "./admin.js";
import type { PausePathKind } from "./pausePath.js";

export const PAUSE_LABEL: Record<PauseSwitch, string> = {
  pool: "Pool",
  game: "Game",
  jackpot: "Jackpot",
  deploy: "Deployment",
  buyTickets: "Bought tickets",
};

const PATH_NAME: Record<PausePathKind, string> = {
  sign: "your wallet signs the transaction",
  fast: "Fast pause, your wallet signs a message and the backend sends the pause",
  prepare: "Prepare for Squads, you paste the base58 into Squads",
  none: "no path",
};

/** The `window.confirm` text for pausing or starting one switch. */
export function pauseConfirm(kind: PausePathKind, sw: PauseSwitch, paused: boolean, pool: string): string {
  const verb = paused ? "Start" : "Pause";
  return `${verb} ${PAUSE_LABEL[sw].toLowerCase()} on pool ${pool}? Path: ${PATH_NAME[kind]}. Only the Admin can restart a paused switch.`;
}
