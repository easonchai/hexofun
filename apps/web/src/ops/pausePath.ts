/**
 * Which way a connected wallet can flip a pause switch. The program lets the
 * Admin pause or start anything, and the Operator pause everything except
 * Bought tickets (`set_pause`, `set_feature_pause`, `set_deploy_pause` take
 * `paused && signer == pool.operator`; `set_buy_tickets_pause` is `has_one =
 * admin`). A Fast pause signer goes through the backend, which holds the
 * Operator key, so it never reaches Bought tickets or a start.
 */
import type { PauseSwitch } from "./admin.js";
import { FAST_PAUSE_SWITCHES, type FastPauseSwitch } from "./fastPause.js";
import type { Role } from "./role.js";

export type PausePathKind = "sign" | "fast" | "prepare" | "none";

export interface PausePath {
  kind: PausePathKind;
  /** One line under the button: why there is no path, or why it is only a Prepare. */
  note: string | null;
}

export const isFastPauseSwitch = (sw: PauseSwitch): sw is FastPauseSwitch =>
  (FAST_PAUSE_SWITCHES as readonly string[]).includes(sw);

/**
 * `paused` is the switch's current state, null while it is unknown. `role` is
 * null with no wallet connected, which can still Prepare. `canSignMessage` is
 * whether the wallet adapter can sign a message, which Fast pause needs.
 */
export function pausePath(
  role: Role | null,
  sw: PauseSwitch,
  paused: boolean | null,
  canSignMessage: boolean,
): PausePath {
  if (paused === null) return { kind: "none", note: "Waiting for the switch state" };
  if (role === "Admin") return { kind: "sign", note: null };
  if (paused) return { kind: "prepare", note: "Only the Admin can restart" };
  if (role === "Operator" && sw !== "buyTickets") return { kind: "sign", note: null };
  if (role === "Fast pause signer" && isFastPauseSwitch(sw)) {
    return canSignMessage
      ? { kind: "fast", note: null }
      : { kind: "prepare", note: "This wallet cannot sign messages, so no Fast pause" };
  }
  return { kind: "prepare", note: null };
}
