/**
 * What the connected wallet is to this pool, from the summary's keys. The
 * badge shows it and the pause block picks each switch's path from it.
 */
import type { OpsSummaryDto } from "../api.js";

export type Role = "Admin" | "Operator" | "Fast pause signer" | "Viewer";

/** Null when no wallet is connected or the summary has not loaded. */
export function roleOf(
  wallet: string | null,
  summary: Pick<OpsSummaryDto, "admin" | "operatorKey" | "fastPauseWallets"> | null,
): Role | null {
  if (wallet === null || summary === null) return null;
  if (wallet === summary.admin) return "Admin";
  if (wallet === summary.operatorKey) return "Operator";
  if ((summary.fastPauseWallets ?? []).includes(wallet)) return "Fast pause signer";
  return "Viewer";
}

/** The badge's words. Every role can run the permissionless cranks. */
export const ROLE_LABEL: Record<Role, string> = {
  Admin: "Admin",
  Operator: "Operator",
  "Fast pause signer": "Fast pause signer",
  Viewer: "Viewer, can run cranks",
};
