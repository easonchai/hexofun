/**
 * Manual grant helpers (off-chain-tickets ticket 23): the message a team wallet
 * signs, the form check, the POST to `/ops/grants` and the error copy per refusal.
 *
 * `grantMessage` mirrors apps/backend/src/api/grants.ts byte for byte. The web
 * cannot import backend source, so each suite pins the same literal.
 */
export const GRANT_REASON_MAX = 200;

const FETCH_TIMEOUT_MS = 15_000;

export function grantMessage(pool: string, wallet: string, amount: number, reason: string, unixSeconds: number): string {
  return `HexVault grant ${pool} ${wallet} ${amount} ${reason} ${unixSeconds}`;
}

/** The ledger row the backend stores. `id` and `delta` arrive as strings (BigInt). */
export interface GrantRow {
  id: string;
  owner: string;
  delta: string;
  ref: string;
  signer: string | null;
}

/** Checks what it can before a signature is asked for; the backend stays the judge. */
export function parseGrantForm(
  values: { wallet: string; amount: string; reason: string },
): { ok: true; wallet: string; amount: number; reason: string } | { ok: false; error: string } {
  const wallet = values.wallet.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return { ok: false, error: "Wallet must be a Solana address." };
  const amount = Number(values.amount.trim());
  if (!/^\d+$/.test(values.amount.trim()) || !Number.isSafeInteger(amount) || amount < 1) {
    return { ok: false, error: "Amount must be a whole number of Tickets, at least 1." };
  }
  if (values.reason.trim().length === 0 || values.reason.length > GRANT_REASON_MAX) {
    return { ok: false, error: `Reason must be 1 to ${GRANT_REASON_MAX} characters.` };
  }
  return { ok: true, wallet, amount, reason: values.reason };
}

export function classifyGrantError(status: number | null, code: string | null, reason: string): string {
  if (status === 404) return "Grants are not enabled on this env.";
  if (code === "WalletNotListed") return "This wallet is not on the list.";
  if (code === "RequestStale") return "The request was too old. Check your clock and sign again.";
  if (code === "BadSignature") return "The signature did not match this grant. Sign again.";
  if (code === "AlreadyApplied") return "That signed grant was already applied.";
  return reason || "Could not reach the server. Try again.";
}

export type GrantResult =
  | { ok: true; row: GrantRow }
  | { ok: false; status: number | null; code: string | null; reason: string };

/** Signs the grant with the connected wallet and posts it. Never throws. */
export async function submitGrant(args: {
  baseUrl: string;
  pool: string;
  signer: string;
  wallet: string;
  amount: number;
  reason: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  encodeSignature: (bytes: Uint8Array) => string;
  nowSeconds: number;
}): Promise<GrantResult> {
  const time = Math.floor(args.nowSeconds);
  try {
    const bytes = await args.signMessage(
      new TextEncoder().encode(grantMessage(args.pool, args.wallet, args.amount, args.reason, time)),
    );
    const response = await fetch(`${args.baseUrl}/ops/grants`, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        wallet: args.wallet,
        amount: args.amount,
        reason: args.reason,
        signer: args.signer,
        time,
        signature: args.encodeSignature(bytes),
      }),
    });
    const json = (await response.json().catch(() => null)) as
      | (Partial<GrantRow> & { code?: string; message?: string })
      | null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: json?.code ?? null,
        reason: json?.message ?? `HTTP ${response.status}`,
      };
    }
    return { ok: true, row: json as GrantRow };
  } catch (error) {
    // Most often the wallet declining the signature request.
    return { ok: false, status: null, code: null, reason: error instanceof Error ? error.message : String(error) };
  }
}
