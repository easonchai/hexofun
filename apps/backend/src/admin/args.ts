// Argument parsing for the admin CLI, split out of index.ts so a unit test
// can import it without index.ts's chain calls running on import. Same
// reason bootstrap.ts's params live in bootstrap/params.ts.
import { parseArgs } from "node:util";

import { PublicKey } from "@solana/web3.js";

import { GRANT_REASON_MAX } from "../api/grants";
import { INVITE_CODE_MAX_USES } from "../api/invite-code";
import { VENUE_KIND } from "../chain/venue-kind";
import { houseCutBps, isoSeconds, wholeUsdc } from "../bootstrap/params";

export interface SetParamsInput {
  readonly epochSeconds?: number;
  /** Unix seconds, from an ISO 8601 flag value. */
  readonly epochAnchor?: number;
  readonly vrfTimeout?: number;
  readonly minDeposit?: bigint;
  /** Atomic units, from a whole-USDC flag value. */
  readonly minJackpot?: bigint;
  readonly payoutTimeout?: number;
  readonly baseRateBps?: number;
}

/** `set_venue_params`: every field optional, only the ones given are sent.
 *  The program bounds each value; the CLI only checks it fits the field. */
export interface SetVenueParamsInput {
  readonly yieldFeeBps?: number;
  readonly idleFloorBps?: number;
  readonly idleTargetBps?: number;
  readonly reserveShareCapBps?: number;
  readonly reserveLiquidityFloorBps?: number;
  /** Atomic units. */
  readonly minVenueMove?: bigint;
  readonly lossToleranceBps?: number;
}

/** `emergency-crank`'s default batch size when `--batch` is not given
 *  (ops-and-envs ticket 08, spec.md "emergency-crank [--batch 5]"). */
export const DEFAULT_EMERGENCY_CRANK_BATCH = 5;

export type AdminCommand =
  | { readonly kind: "pause" }
  | { readonly kind: "unpause" }
  /** game-jackpot-pause ticket 02: `set_feature_pause`. The pause commands
   *  take the operator or the admin; the start commands the admin alone. */
  | { readonly kind: "pause-game" }
  | { readonly kind: "pause-jackpot" }
  | { readonly kind: "start-game" }
  | { readonly kind: "start-jackpot" }
  /** yield-claimer ticket 10: `set_deploy_pause`, same role rule as the
   *  feature pauses. */
  | { readonly kind: "pause-deploy" }
  | { readonly kind: "start-deploy" }
  /** `set_buy_tickets_pause`: Admin only in both directions. */
  | { readonly kind: "pause-buy-tickets" }
  | { readonly kind: "start-buy-tickets" }
  | { readonly kind: "set-venue-params"; readonly params: SetVenueParamsInput }
  | {
      readonly kind: "set-treasury-accounts";
      readonly treasury: PublicKey;
      readonly buybackReserve: PublicKey;
    }
  /** Not Admin-gated in the program: whoever signs pays from their own USDC. */
  | { readonly kind: "cover-deficit"; readonly amount: bigint }
  | { readonly kind: "fund-jackpot"; readonly amount: bigint }
  /** Admin path only (uncapped); the operator path is the referral job. */
  | { readonly kind: "set-params"; readonly params: SetParamsInput }
  | { readonly kind: "set-operator"; readonly key: PublicKey }
  | { readonly kind: "propose-admin"; readonly key: PublicKey }
  | { readonly kind: "accept-admin" }
  /** venue-switch ticket 03: announce a venue change (replaces an open one and
   *  restarts the 48 hour lock), or withdraw it. Admin only. */
  | {
      readonly kind: "propose-venue";
      readonly venueKind: number;
      readonly program: PublicKey;
      readonly market: PublicKey;
      readonly reserve: PublicKey;
      readonly ctoken: PublicKey;
    }
  | { readonly kind: "cancel-venue" }
  /** venue-switch ticket 04: brings `amount` raw atomic USDC home from the
   *  venue, with the deploy pause set in the same transaction. */
  | { readonly kind: "drain-venue"; readonly amount: bigint }
  /** venue-switch ticket 05: executes the proposal once the lock has elapsed
   *  and the old position is down to dust. Permissionless; no flags. */
  | { readonly kind: "migrate-venue" }
  /** Never touches the chain: `create-invite` writes straight to Postgres,
   *  so `main()` handles it before a ChainService is even built. */
  | {
      readonly kind: "create-invite";
      readonly maxUses: number;
      readonly owner?: PublicKey;
      readonly count: number;
    }
  /** Never touches the chain: signs with `keypair` and posts to the backend's
   *  `POST /ops/grants`, so `main()` handles it before a ChainService is built. */
  | {
      readonly kind: "grant-tickets";
      readonly owner: PublicKey;
      readonly amount: bigint;
      readonly reason: string;
      /** Path to a solana keypair file whose wallet is on `OPS_WALLETS`. */
      readonly keypair: string;
      /** Defaults to this machine's backend port. */
      readonly backend?: string;
    }
  /** Irreversible; refused unless `confirm` matches the configured pool. */
  | { readonly kind: "shutdown"; readonly confirm: bigint }
  /** Permissionless: any signer may run this. */
  | { readonly kind: "emergency-crank"; readonly batch: number }
  | { readonly kind: "sweep-house" }
  /** Permissionless stuck-state exits the operator does not yet send on its
   *  own (mainnet readiness 2026-09-28, blocker 4): an Open or Requested
   *  Ended, Drawing or Drawn Epoch past its own deadline. The program checks
   *  the deadline; this only names the account. */
  | { readonly kind: "rollover-epoch"; readonly epochId: bigint };

export const USAGE = [
  "usage: admin <command> [flags]",
  "  set-params [--epoch-seconds N] [--epoch-anchor ISO8601] [--vrf-timeout N] [--min-deposit N] [--min-jackpot USDC] [--payout-timeout N] [--base-rate-bps N]",
  "  pause",
  "  unpause",
  "  pause-game | pause-jackpot   (operator or admin)",
  "  start-game | start-jackpot   (admin only)",
  "  pause-deploy   (operator or admin; stops deploy_to_venue)",
  "  start-deploy   (admin only)",
  "  pause-buy-tickets | start-buy-tickets   (admin only; the Bought tickets pause)",
  "  set-venue-params [--yield-fee-bps N] [--idle-floor-bps N] [--idle-target-bps N] [--reserve-share-cap-bps N] [--reserve-liquidity-floor-bps N] [--min-venue-move N] [--loss-tolerance-bps N]   (N for --min-venue-move is raw atomic USDC)",
  "  set-treasury-accounts --treasury PUBKEY --buyback-reserve PUBKEY   (token accounts of the pool's mint)",
  "  cover-deficit --amount N   (any funded signer; pays N raw atomic USDC from its own account, capped at the deficit)",
  "  fund-jackpot --amount N   (N is raw atomic hexUSDC, 6 decimals)",
  "  set-operator --key PUBKEY",
  "  propose-admin --key PUBKEY",
  "  accept-admin",
  "  propose-venue --kind klend|stub|kvault|N --program PUBKEY --market PUBKEY --reserve PUBKEY --ctoken PUBKEY   (admin only; replaces an open proposal and restarts the 48 hour lock; deploys stop until cancel-venue or the migration)",
  "  cancel-venue   (admin only; closes the open proposal, rent back to the admin)",
  "  migrate-venue   (permissionless; repins the pool to the proposed venue once the 48 hour lock has elapsed and the old position is down to min-venue-move; no USDC moves; deploys then use the new venue)",
  "  drain-venue --amount N   (admin or operator; brings N raw atomic USDC home from the venue and pauses deploys in the same transaction, so the crank cannot redeploy; start-deploy resumes)",
  `  create-invite [--max-uses N] [--owner PUBKEY] [--count K]   (max-uses defaults to ${INVITE_CODE_MAX_USES})`,
  "  grant-tickets --owner PUBKEY --amount N --reason TEXT --keypair FILE [--backend URL]   (a team wallet signs; the backend books a grant_admin row, up to the Game config's maxAdminGrant; prints the row id)",
  "  shutdown --confirm POOL_ID  (irreversible; POOL_ID must match the configured pool)",
  `  emergency-crank [--batch N]   (permissionless; N players per transaction, default ${DEFAULT_EMERGENCY_CRANK_BATCH})`,
  "  sweep-house",
  "  rollover-epoch --epoch N   (permissionless; Ended, Drawing or Drawn epoch past its timeout)",
].join("\n");

function positiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${flag} must be a positive whole number, got "${raw}"`);
  }
  return value;
}

function positiveBigInt(flag: string, raw: string): bigint {
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`--${flag} must be a positive whole number, got "${raw}"`);
  }
  return BigInt(raw);
}

function nonNegativeBigInt(flag: string, raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${flag} must be a non-negative whole number, got "${raw}"`);
  }
  return BigInt(raw);
}

/** A basis-point field that is a u16 in `SetVenueParamsArgs`. The program's
 *  own bound per field is tighter and is what refuses a bad value. */
function u16Bps(flag: string, raw: string): number {
  // Digits only: Number("") is 0, Number("1e2") is 100 and Number("0x10") is 16.
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value > 65_535) {
    throw new Error(`--${flag} must be a whole number from 0 to 65535, got "${raw}"`);
  }
  return value;
}

function pubkey(flag: string, raw: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch (cause) {
    throw new Error(`--${flag} must be a base58 pubkey, got "${raw}"`, { cause });
  }
}

/** A venue kind by name, or its raw `Pool::venue_kind` byte. The program
 *  decides which kinds a build supports; this only names them. */
const VENUE_KIND_NAMES: Readonly<Record<string, number>> = { ...VENUE_KIND, kvault: 2 };

function venueKindFlag(flag: string, raw: string): number {
  const named = VENUE_KIND_NAMES[raw];
  if (named !== undefined) return named;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > 255) {
    throw new Error(
      `--${flag} must be one of ${Object.keys(VENUE_KIND_NAMES).join(", ")} or a number 0 to 255, got "${raw}"`,
    );
  }
  return value;
}

/** No flags accepted; `pause`/`unpause`/`accept-admin` take none. */
function rejectExtra(rest: readonly string[]): void {
  if (rest.length > 0) {
    throw new Error(`unexpected argument "${rest[0]}"\n${USAGE}`);
  }
}

/** The one required flag of a single-flag command, as written. */
function oneFlag(command: string, flag: string, rest: readonly string[]): string {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { [flag]: { type: "string" } },
      allowPositionals: false,
    }));
  } catch (cause) {
    throw new Error(USAGE, { cause });
  }
  const value = values[flag];
  if (typeof value !== "string") {
    throw new Error(`${command} needs --${flag}\n${USAGE}`);
  }
  return value;
}

/** Takes argv without the node and script entries. */
export function parseAdminCommand(argv: readonly string[]): AdminCommand {
  const [command, ...rest] = argv;

  switch (command) {
    case "pause":
      rejectExtra(rest);
      return { kind: "pause" };

    case "unpause":
      rejectExtra(rest);
      return { kind: "unpause" };

    case "pause-game":
    case "pause-jackpot":
    case "start-game":
    case "start-jackpot":
    case "pause-deploy":
    case "start-deploy":
      rejectExtra(rest);
      return { kind: command };

    case "pause-buy-tickets":
    case "start-buy-tickets":
      rejectExtra(rest);
      return { kind: command };

    case "set-venue-params": {
      let values: {
        "yield-fee-bps"?: string;
        "idle-floor-bps"?: string;
        "idle-target-bps"?: string;
        "reserve-share-cap-bps"?: string;
        "reserve-liquidity-floor-bps"?: string;
        "min-venue-move"?: string;
        "loss-tolerance-bps"?: string;
      };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            "yield-fee-bps": { type: "string" },
            "idle-floor-bps": { type: "string" },
            "idle-target-bps": { type: "string" },
            "reserve-share-cap-bps": { type: "string" },
            "reserve-liquidity-floor-bps": { type: "string" },
            "min-venue-move": { type: "string" },
            "loss-tolerance-bps": { type: "string" },
          },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }

      const params: SetVenueParamsInput = {
        ...(values["yield-fee-bps"] !== undefined && {
          yieldFeeBps: u16Bps("yield-fee-bps", values["yield-fee-bps"]),
        }),
        ...(values["idle-floor-bps"] !== undefined && {
          idleFloorBps: u16Bps("idle-floor-bps", values["idle-floor-bps"]),
        }),
        ...(values["idle-target-bps"] !== undefined && {
          idleTargetBps: u16Bps("idle-target-bps", values["idle-target-bps"]),
        }),
        ...(values["reserve-share-cap-bps"] !== undefined && {
          reserveShareCapBps: u16Bps("reserve-share-cap-bps", values["reserve-share-cap-bps"]),
        }),
        ...(values["reserve-liquidity-floor-bps"] !== undefined && {
          reserveLiquidityFloorBps: u16Bps(
            "reserve-liquidity-floor-bps",
            values["reserve-liquidity-floor-bps"],
          ),
        }),
        ...(values["min-venue-move"] !== undefined && {
          minVenueMove: positiveBigInt("min-venue-move", values["min-venue-move"]),
        }),
        ...(values["loss-tolerance-bps"] !== undefined && {
          lossToleranceBps: u16Bps("loss-tolerance-bps", values["loss-tolerance-bps"]),
        }),
      };
      if (Object.keys(params).length === 0) {
        throw new Error(`set-venue-params needs at least one flag\n${USAGE}`);
      }
      return { kind: "set-venue-params", params };
    }

    case "set-treasury-accounts": {
      let values: { treasury?: string; "buyback-reserve"?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: { treasury: { type: "string" }, "buyback-reserve": { type: "string" } },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      if (typeof values.treasury !== "string") {
        throw new Error(`set-treasury-accounts needs --treasury\n${USAGE}`);
      }
      if (typeof values["buyback-reserve"] !== "string") {
        throw new Error(`set-treasury-accounts needs --buyback-reserve\n${USAGE}`);
      }
      return {
        kind: "set-treasury-accounts",
        treasury: pubkey("treasury", values.treasury),
        buybackReserve: pubkey("buyback-reserve", values["buyback-reserve"]),
      };
    }

    case "migrate-venue":
      rejectExtra(rest);
      return { kind: "migrate-venue" };

    case "drain-venue":
      return {
        kind: "drain-venue",
        amount: positiveBigInt("amount", oneFlag(command, "amount", rest)),
      };

    case "cover-deficit":
      return {
        kind: "cover-deficit",
        amount: positiveBigInt("amount", oneFlag(command, "amount", rest)),
      };

    case "fund-jackpot":
      return {
        kind: "fund-jackpot",
        amount: positiveBigInt("amount", oneFlag(command, "amount", rest)),
      };

    case "set-operator":
      return { kind: "set-operator", key: pubkey("key", oneFlag(command, "key", rest)) };

    case "propose-admin":
      return { kind: "propose-admin", key: pubkey("key", oneFlag(command, "key", rest)) };

    case "accept-admin":
      rejectExtra(rest);
      return { kind: "accept-admin" };

    case "cancel-venue":
      rejectExtra(rest);
      return { kind: "cancel-venue" };

    case "propose-venue": {
      let values: {
        kind?: string;
        program?: string;
        market?: string;
        reserve?: string;
        ctoken?: string;
      };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            kind: { type: "string" },
            program: { type: "string" },
            market: { type: "string" },
            reserve: { type: "string" },
            ctoken: { type: "string" },
          },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      for (const flag of ["kind", "program", "market", "reserve", "ctoken"] as const) {
        if (typeof values[flag] !== "string") {
          throw new Error(`propose-venue needs --${flag}\n${USAGE}`);
        }
      }
      return {
        kind: "propose-venue",
        venueKind: venueKindFlag("kind", values.kind as string),
        program: pubkey("program", values.program as string),
        market: pubkey("market", values.market as string),
        reserve: pubkey("reserve", values.reserve as string),
        ctoken: pubkey("ctoken", values.ctoken as string),
      };
    }

    case "set-params": {
      let values: {
        "epoch-seconds"?: string;
        "epoch-anchor"?: string;
        "vrf-timeout"?: string;
        "min-deposit"?: string;
        "min-jackpot"?: string;
        "payout-timeout"?: string;
        "base-rate-bps"?: string;
      };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            "epoch-seconds": { type: "string" },
            "epoch-anchor": { type: "string" },
            "vrf-timeout": { type: "string" },
            "min-deposit": { type: "string" },
            "min-jackpot": { type: "string" },
            "payout-timeout": { type: "string" },
            "base-rate-bps": { type: "string" },
          },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }

      const params: SetParamsInput = {
        ...(values["epoch-seconds"] !== undefined && {
          epochSeconds: positiveInt("epoch-seconds", values["epoch-seconds"]),
        }),
        ...(values["epoch-anchor"] !== undefined && {
          epochAnchor: isoSeconds("epoch-anchor", values["epoch-anchor"]),
        }),
        ...(values["vrf-timeout"] !== undefined && {
          vrfTimeout: positiveInt("vrf-timeout", values["vrf-timeout"]),
        }),
        ...(values["min-deposit"] !== undefined && {
          minDeposit: nonNegativeBigInt("min-deposit", values["min-deposit"]),
        }),
        ...(values["min-jackpot"] !== undefined && {
          minJackpot: wholeUsdc("min-jackpot", values["min-jackpot"]),
        }),
        ...(values["payout-timeout"] !== undefined && {
          payoutTimeout: positiveInt("payout-timeout", values["payout-timeout"]),
        }),
        ...(values["base-rate-bps"] !== undefined && {
          baseRateBps: houseCutBps("base-rate-bps", values["base-rate-bps"]),
        }),
      };
      if (Object.keys(params).length === 0) {
        throw new Error(`set-params needs at least one flag\n${USAGE}`);
      }
      return { kind: "set-params", params };
    }

    case "create-invite": {
      let values: { "max-uses"?: string; owner?: string; count?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            "max-uses": { type: "string" },
            owner: { type: "string" },
            count: { type: "string" },
          },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      const maxUsesRaw = values["max-uses"];
      return {
        kind: "create-invite",
        // Invite codes are single use from now on (ticket 07): --max-uses
        // defaults to INVITE_CODE_MAX_USES rather than being required.
        maxUses: maxUsesRaw !== undefined ? positiveInt("max-uses", maxUsesRaw) : INVITE_CODE_MAX_USES,
        count: values.count !== undefined ? positiveInt("count", values.count) : 1,
        ...(values.owner !== undefined ? { owner: pubkey("owner", values.owner) } : {}),
      };
    }

    case "grant-tickets": {
      let values: { owner?: string; amount?: string; reason?: string; keypair?: string; backend?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            owner: { type: "string" },
            amount: { type: "string" },
            reason: { type: "string" },
            keypair: { type: "string" },
            backend: { type: "string" },
          },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      for (const flag of ["owner", "amount", "reason", "keypair"] as const) {
        if (values[flag] === undefined) throw new Error(`grant-tickets needs --${flag}\n${USAGE}`);
      }
      const amount = positiveBigInt("amount", values.amount!);
      // The request carries a JSON number, which is exact only to 2^53.
      if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`--amount must be at most ${Number.MAX_SAFE_INTEGER}, got "${values.amount}"`);
      }
      const reason = values.reason!;
      if (reason.trim().length === 0 || reason.length > GRANT_REASON_MAX) {
        throw new Error(`--reason must be 1 to ${GRANT_REASON_MAX} characters`);
      }
      return {
        kind: "grant-tickets",
        owner: pubkey("owner", values.owner!),
        amount,
        reason,
        keypair: values.keypair!,
        ...(values.backend !== undefined ? { backend: values.backend } : {}),
      };
    }

    case "shutdown":
      return {
        kind: "shutdown",
        confirm: nonNegativeBigInt("confirm", oneFlag(command, "confirm", rest)),
      };

    case "emergency-crank": {
      let values: { batch?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: { batch: { type: "string" } },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      return {
        kind: "emergency-crank",
        batch:
          values.batch !== undefined
            ? positiveInt("batch", values.batch)
            : DEFAULT_EMERGENCY_CRANK_BATCH,
      };
    }

    case "sweep-house":
      rejectExtra(rest);
      return { kind: "sweep-house" };

    case "rollover-epoch":
      return {
        kind: "rollover-epoch",
        epochId: nonNegativeBigInt("epoch", oneFlag(command, "epoch", rest)),
      };

    default:
      throw new Error(USAGE);
  }
}
