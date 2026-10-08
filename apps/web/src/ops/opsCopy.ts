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

/** `window.confirm` before a hand drain. */
export function drainConfirm(amount: string, pool: string): string {
  return `Drain ${amount} from the venue into pool ${pool}'s own vault? It also pauses deployment, and only the Admin can restart it. Players' balances do not change, but the drained USDC earns nothing until it is deployed again.`;
}

/** `window.confirm` before `migrate_venue`. */
export function migrateConfirm(kind: string, pool: string): string {
  return `Move pool ${pool} to the proposed ${kind} venue? Anything left at the old venue stays there for good. Players' balances do not change; the idle USDC earns nothing until deploys resume.`;
}

/** `window.confirm` before Set params or Set venue params, listing each change. */
export function paramsConfirm(
  title: string,
  changes: readonly { label: string; old: bigint; next: bigint }[],
  pool: string,
): string {
  const effect =
    title === "Set venue params"
      ? "This changes how the pool keeps and moves its idle USDC. Players' balances do not change."
      : "Players see the new rules from the next epoch that reads them.";
  const lines = changes.map((c) => `${c.label}: ${c.old} to ${c.next}`).join("\n");
  return `${title} on pool ${pool}?\n${lines}\n${effect}`;
}
