/**
 * Owns the Referrals screen's state (ticket 11): the `GET /referrals/:wallet`
 * poll and the copy-to-clipboard flow for a share link. Referrals.tsx only
 * reads what this returns, mirroring useAccessGate.ts / useBuyTickets.ts.
 */
import { useCallback, useState } from "react";

import { track } from "./analytics.js";
import { apiBaseUrl, fetchReferrals, type ReferralsDto } from "./api.js";
import { shareLink } from "./referrals.js";
import { useApiPoll } from "./useApiPoll.js";

export interface ReferralsState {
  data: ReferralsDto | null;
  error: string | null;
  /** The owned code whose link was just copied, for a "copied" label; clears
   *  itself after a second. */
  copiedCode: string | null;
  copyLink: (code: string) => void;
}

export function useReferrals(owner: string | undefined): ReferralsState {
  const loadReferrals = useCallback(
    (signal: AbortSignal) =>
      owner
        ? fetchReferrals(apiBaseUrl(), owner, signal)
        : Promise.resolve({ ok: false as const, reason: "no wallet connected" }),
    [owner],
  );
  const poll = useApiPoll(loadReferrals, 10_000, owner);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const copyLink = useCallback((code: string) => {
    const link = shareLink(window.location.origin, code);
    track("referral_link_copied");
    void (async () => {
      try {
        await navigator.clipboard.writeText(link);
        setCopiedCode(code);
        window.setTimeout(
          () => setCopiedCode((current) => (current === code ? null : current)),
          1200,
        );
      } catch {
        window.prompt("Copy link", link);
      }
    })();
  }, []);

  return { data: poll.data, error: poll.error, copiedCode, copyLink };
}
