// Argument parsing for the admin CLI, split out of index.ts so a unit test
// can import it without index.ts's chain calls running on import. Same
// reason bootstrap.ts's params live in bootstrap/params.ts.
import { parseArgs } from "node:util";

import { PublicKey } from "@solana/web3.js";

import { INVITE_CODE_MAX_USES } from "../api/invite-code";
import { houseCutBps, isoSeconds, wholeUsdc } from "../bootstrap/params";

export interface SetParamsInput {
  readonly epochSeconds?: number;
  /** Unix seconds, from an ISO 8601 flag value. */
  readonly epochAnchor?: number;
  readonly roundSeconds?: number;
  readonly closeBuffer?: number;
  readonly vrfTimeout?: number;
  readonly minDeposit?: bigint;
  readonly houseCutBps?: number;
  /** Atomic units, from a whole-USDC flag value. */
  readonly minJackpot?: bigint;
  readonly payoutTimeout?: number;
  readonly baseRateBps?: number;
  readonly ticketsPerUsdc?: number;
  readonly bonusCapBps?: number;
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
  | { readonly kind: "grant-tickets"; readonly owner: PublicKey; readonly amount: bigint }
  | { readonly kind: "set-params"; readonly params: SetParamsInput }
  | { readonly kind: "set-operator"; readonly key: PublicKey }
  | { readonly kind: "propose-admin"; readonly key: PublicKey }
  | { readonly kind: "accept-admin" }
  /** Never touches the chain: `create-invite` writes straight to Postgres,
   *  so `main()` handles it before a ChainService is even built. */
  | {
      readonly kind: "create-invite";
      readonly maxUses: number;
      readonly owner?: PublicKey;
      readonly count: number;
    }
  /** Irreversible; refused unless `confirm` matches the configured pool. */
  | { readonly kind: "shutdown"; readonly confirm: bigint }
  /** Permissionless: any signer may run this. */
  | { readonly kind: "emergency-crank"; readonly batch: number }
  | { readonly kind: "sweep-house" }
  /** Permissionless stuck-state exits the operator does not yet send on its
   *  own (mainnet readiness 2026-09-28, blocker 4): an Open or Requested
   *  Round past `vrf_timeout`, or an Ended, Drawing or Drawn Epoch past
   *  its own deadline. The program checks the deadline; this only names the
   *  account. */
  | { readonly kind: "void-round"; readonly roundId: bigint }
  | { readonly kind: "rollover-epoch"; readonly epochId: bigint };

export const USAGE = [
  "usage: admin <command> [flags]",
  "  set-params [--epoch-seconds N] [--epoch-anchor ISO8601] [--round-seconds N] [--close-buffer N] [--vrf-timeout N] [--min-deposit N] [--house-cut-bps N] [--min-jackpot USDC] [--payout-timeout N] [--base-rate-bps N] [--tickets-per-usdc N] [--bonus-cap-bps N]",
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
  "  grant-tickets --owner PUBKEY --amount N   (admin path, uncapped; N is a whole number of tickets)",
  "  set-operator --key PUBKEY",
  "  propose-admin --key PUBKEY",
  "  accept-admin",
  `  create-invite [--max-uses N] [--owner PUBKEY] [--count K]   (max-uses defaults to ${INVITE_CODE_MAX_USES})`,
  "  shutdown --confirm POOL_ID   (irreversible; POOL_ID must match the configured pool)",
  `  emergency-crank [--batch N]   (permissionless; N players per transaction, default ${DEFAULT_EMERGENCY_CRANK_BATCH})`,
  "  sweep-house",
  "  void-round --round N   (permissionless; Open or Requested round past vrf_timeout)",
  "  rollover-epoch --epoch N   (permissionless; Ended, Drawing or Drawn epoch past its timeout)",
].join("\n");

function positiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${flag} must be a positive whole number, got "${raw}"`);
  }
  return value;
}

function nonNegativeInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${flag} must be a non-negative whole number, got "${raw}"`);
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

/** `tickets_per_usdc` is a u16 and must be > 0 (a rate of zero would divide
 *  by nothing when pricing a purchase). */
function ticketsPerUsdc(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`--${flag} must be a whole number from 1 to 65535, got "${raw}"`);
  }
  return value;
}

/** A basis-point field that is a u16 in `SetVenueParamsArgs`. The program's
 *  own bound per field is tighter and is what refuses a bad value. */
function u16Bps(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
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

    case "grant-tickets": {
      let values: { owner?: string; amount?: string };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: { owner: { type: "string" }, amount: { type: "string" } },
          allowPositionals: false,
        }));
      } catch (cause) {
        throw new Error(USAGE, { cause });
      }
      if (typeof values.owner !== "string") {
        throw new Error(`grant-tickets needs --owner\n${USAGE}`);
      }
      if (typeof values.amount !== "string") {
        throw new Error(`grant-tickets needs --amount\n${USAGE}`);
      }
      return {
        kind: "grant-tickets",
        owner: pubkey("owner", values.owner),
        amount: positiveBigInt("amount", values.amount),
      };
    }

    case "set-operator":
      return { kind: "set-operator", key: pubkey("key", oneFlag(command, "key", rest)) };

    case "propose-admin":
      return { kind: "propose-admin", key: pubkey("key", oneFlag(command, "key", rest)) };

    case "accept-admin":
      rejectExtra(rest);
      return { kind: "accept-admin" };

    case "set-params": {
      let values: {
        "epoch-seconds"?: string;
        "epoch-anchor"?: string;
        "round-seconds"?: string;
        "close-buffer"?: string;
        "vrf-timeout"?: string;
        "min-deposit"?: string;
        "house-cut-bps"?: string;
        "min-jackpot"?: string;
        "payout-timeout"?: string;
        "base-rate-bps"?: string;
        "tickets-per-usdc"?: string;
        "bonus-cap-bps"?: string;
      };
      try {
        ({ values } = parseArgs({
          args: [...rest],
          options: {
            "epoch-seconds": { type: "string" },
            "epoch-anchor": { type: "string" },
            "round-seconds": { type: "string" },
            "close-buffer": { type: "string" },
            "vrf-timeout": { type: "string" },
            "min-deposit": { type: "string" },
            "house-cut-bps": { type: "string" },
            "min-jackpot": { type: "string" },
            "payout-timeout": { type: "string" },
            "base-rate-bps": { type: "string" },
            "tickets-per-usdc": { type: "string" },
            "bonus-cap-bps": { type: "string" },
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
        ...(values["round-seconds"] !== undefined && {
          roundSeconds: positiveInt("round-seconds", values["round-seconds"]),
        }),
        ...(values["close-buffer"] !== undefined && {
          closeBuffer: nonNegativeInt("close-buffer", values["close-buffer"]),
        }),
        ...(values["vrf-timeout"] !== undefined && {
          vrfTimeout: positiveInt("vrf-timeout", values["vrf-timeout"]),
        }),
        ...(values["min-deposit"] !== undefined && {
          minDeposit: nonNegativeBigInt("min-deposit", values["min-deposit"]),
        }),
        ...(values["house-cut-bps"] !== undefined && {
          houseCutBps: houseCutBps("house-cut-bps", values["house-cut-bps"]),
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
        ...(values["tickets-per-usdc"] !== undefined && {
          ticketsPerUsdc: ticketsPerUsdc("tickets-per-usdc", values["tickets-per-usdc"]),
        }),
        ...(values["bonus-cap-bps"] !== undefined && {
          bonusCapBps: houseCutBps("bonus-cap-bps", values["bonus-cap-bps"]),
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

    case "void-round":
      return {
        kind: "void-round",
        roundId: nonNegativeBigInt("round", oneFlag(command, "round", rest)),
      };

    case "rollover-epoch":
      return {
        kind: "rollover-epoch",
        epochId: nonNegativeBigInt("epoch", oneFlag(command, "epoch", rest)),
      };

    default:
      throw new Error(USAGE);
  }
}
