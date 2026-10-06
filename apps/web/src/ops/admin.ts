/**
 * Admin actions for the Ops console: instruction builders, the parameter diff,
 * the bounds the program enforces, and the base58 transaction Squads imports.
 * Pure apart from the builders reading a `Program`'s IDL, so vitest covers all
 * of it without a wallet or a chain. The CLI's equivalents are in
 * apps/backend/src/admin/ (`index.ts`, `squads.ts`); keep the two in step.
 */
import { BN, utils } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";

import { acceptedAta, jackpotVaultAddress, method, playerAddress, type HexVaultProgram } from "../chain.js";

/** Field name to value, in the program's own units (atomic USDC, seconds, bps). */
export type Values = Record<string, bigint>;

export type Bits = "u16" | "u64" | "i64";
export interface Field {
  key: string;
  label: string;
  bits: Bits;
  /** Shows a USDC figure beside the atomic one. */
  usdc?: boolean;
}

export const PARAMS_FIELDS: readonly Field[] = [
  { key: "epochSeconds", label: "Epoch length (s)", bits: "i64" },
  { key: "epochAnchor", label: "Epoch anchor (unix s)", bits: "i64" },
  { key: "roundSeconds", label: "Round length (s)", bits: "i64" },
  { key: "closeBuffer", label: "Close buffer (s)", bits: "i64" },
  { key: "vrfTimeout", label: "VRF timeout (s)", bits: "i64" },
  { key: "minDeposit", label: "Minimum deposit (atomic)", bits: "u64", usdc: true },
  { key: "houseCutBps", label: "House cut (bps)", bits: "u16" },
  { key: "minJackpot", label: "Minimum jackpot (atomic)", bits: "u64", usdc: true },
  { key: "payoutTimeout", label: "Payout timeout (s)", bits: "i64" },
  { key: "baseRateBps", label: "Base rate (bps)", bits: "u16" },
  { key: "ticketsPerUsdc", label: "Tickets per USDC", bits: "u16" },
  { key: "bonusCapBps", label: "Bonus cap (bps)", bits: "u16" },
];

export const VENUE_FIELDS: readonly Field[] = [
  { key: "yieldFeeBps", label: "Yield fee (bps)", bits: "u16" },
  { key: "idleFloorBps", label: "Idle floor (bps)", bits: "u16" },
  { key: "idleTargetBps", label: "Idle target (bps)", bits: "u16" },
  { key: "reserveShareCapBps", label: "Reserve share cap (bps)", bits: "u16" },
  { key: "reserveLiquidityFloorBps", label: "Reserve liquidity floor (bps)", bits: "u16" },
  { key: "minVenueMove", label: "Minimum venue move (atomic)", bits: "u64", usdc: true },
  { key: "lossToleranceBps", label: "Loss tolerance (bps)", bits: "u16" },
];

const MAX: Record<Bits, bigint> = {
  u16: 65_535n,
  u64: (1n << 64n) - 1n,
  i64: (1n << 63n) - 1n,
};

// Bounds from programs/hex_vault/src/constants.rs and custody.rs. The two
// timeout floors are the production ones; a test-vrf localnet build accepts 1.
const MAX_YIELD_FEE_BPS = 2_000n;
const MAX_IDLE_TARGET_BPS = 5_000n;
const MAX_RESERVE_SHARE_CAP_BPS = 2_000n;
const MIN_RESERVE_LIQUIDITY_FLOOR_BPS = 10_000n;
const MAX_RESERVE_LIQUIDITY_FLOOR_BPS = 60_000n;
const MAX_MIN_VENUE_MOVE = 10_000_000_000n;
const MAX_LOSS_TOLERANCE_BPS = 100n;
const MIN_VRF_TIMEOUT = 180n;
const MIN_PAYOUT_TIMEOUT = 600n;
const BPS = 10_000n;

export interface Change {
  key: string;
  label: string;
  old: bigint;
  next: bigint;
}

export interface ParamDiff {
  changes: Change[];
  /** Input that is not a whole number or does not fit the field. Nothing is sent while any remain. */
  errors: string[];
}

/** Blank input means keep the current value; only fields that differ come back. */
export function diffParams(
  fields: readonly Field[],
  current: Values,
  inputs: Record<string, string>,
): ParamDiff {
  const changes: Change[] = [];
  const errors: string[] = [];
  for (const f of fields) {
    const raw = (inputs[f.key] ?? "").trim();
    if (raw === "") continue;
    if (!/^\d+$/.test(raw)) {
      errors.push(`${f.label}: enter a whole number`);
      continue;
    }
    const next = BigInt(raw);
    if (next > MAX[f.bits]) {
      errors.push(`${f.label}: too large for ${f.bits}`);
      continue;
    }
    const old = current[f.key];
    if (old === undefined) {
      errors.push(`${f.label}: current value unknown`);
      continue;
    }
    if (next !== old) changes.push({ key: f.key, label: f.label, old, next });
  }
  return { changes, errors };
}

/**
 * The program's `require!`s, checked before signing. Cross-field rules are
 * judged on the merged result, as the program does.
 */
export function checkBounds(
  kind: "params" | "venue",
  current: Values,
  changes: readonly Change[],
): string[] {
  const v: Values = { ...current };
  for (const c of changes) v[c.key] = c.next;
  const touched = (k: string) => changes.some((c) => c.key === k);
  const errors: string[] = [];
  const need = (ok: boolean, msg: string) => {
    if (!ok) errors.push(msg);
  };
  const g = (k: string): bigint => v[k] ?? 0n;

  if (kind === "venue") {
    need(!touched("yieldFeeBps") || g("yieldFeeBps") <= MAX_YIELD_FEE_BPS, "Yield fee is capped at 2000 bps (20%)");
    need(!touched("idleTargetBps") || g("idleTargetBps") <= MAX_IDLE_TARGET_BPS, "Idle target is capped at 5000 bps (50%)");
    need(g("idleFloorBps") <= g("idleTargetBps"), "Idle floor must not be above the idle target");
    need(
      !touched("reserveShareCapBps") || g("reserveShareCapBps") <= MAX_RESERVE_SHARE_CAP_BPS,
      "Reserve share cap is capped at 2000 bps (20%)",
    );
    need(
      !touched("reserveLiquidityFloorBps") ||
        (g("reserveLiquidityFloorBps") >= MIN_RESERVE_LIQUIDITY_FLOOR_BPS &&
          g("reserveLiquidityFloorBps") <= MAX_RESERVE_LIQUIDITY_FLOOR_BPS),
      "Reserve liquidity floor must be between 10000 and 60000 bps",
    );
    need(
      !touched("minVenueMove") || (g("minVenueMove") > 0n && g("minVenueMove") <= MAX_MIN_VENUE_MOVE),
      "Minimum venue move must be above 0 and at most 10,000 USDC",
    );
    need(
      !touched("lossToleranceBps") || g("lossToleranceBps") <= MAX_LOSS_TOLERANCE_BPS,
      "Loss tolerance is capped at 100 bps (1%)",
    );
    return errors;
  }

  for (const k of ["epochSeconds", "epochAnchor", "roundSeconds"]) {
    need(!touched(k) || g(k) > 0n, `${k} must be above 0`);
  }
  need(!touched("closeBuffer") || g("closeBuffer") < g("roundSeconds"), "Close buffer must be under the round length");
  need(!touched("roundSeconds") || g("roundSeconds") > g("closeBuffer"), "Round length must be above the close buffer");
  need(!touched("vrfTimeout") || g("vrfTimeout") >= MIN_VRF_TIMEOUT, "VRF timeout must be at least 180 s");
  need(!touched("payoutTimeout") || g("payoutTimeout") >= MIN_PAYOUT_TIMEOUT, "Payout timeout must be at least 600 s");
  need(g("payoutTimeout") < g("epochSeconds"), "Payout timeout must be under the epoch length");
  for (const k of ["houseCutBps", "baseRateBps", "bonusCapBps"]) {
    need(!touched(k) || g(k) <= BPS, `${k} is at most 10000 bps (100%)`);
  }
  need(!touched("ticketsPerUsdc") || g("ticketsPerUsdc") > 0n, "Tickets per USDC must be above 0");
  return errors;
}

/** "12.5" to 12_500_000n. Null for zero, junk or more than 6 decimals. */
export function parseUsdc(input: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  const atomic = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  return atomic > 0n && atomic <= MAX.u64 ? atomic : null;
}

/** Whole number above zero, or null. */
export function parseAmount(input: string): bigint | null {
  if (!/^\d+$/.test(input.trim())) return null;
  const n = BigInt(input.trim());
  return n > 0n && n <= MAX.u64 ? n : null;
}

export type AdminModeName = "sign" | "prepare" | "unknown";

/** Sign when the connected wallet is the Pool's Admin; otherwise prepare for it. */
export function adminMode(connected: string | null, admin: string | null): AdminModeName {
  if (admin === null) return "unknown";
  return connected === admin ? "sign" : "prepare";
}

export type PauseSwitch = "pool" | "game" | "jackpot" | "deploy" | "buyTickets";

export function pauseIx(
  program: HexVaultProgram,
  sw: PauseSwitch,
  paused: boolean,
  signer: PublicKey,
  pool: PublicKey,
): Promise<TransactionInstruction> {
  switch (sw) {
    case "pool":
      return method(program, "setPause")(paused).accounts({ signer, pool }).instruction();
    case "game":
      return method(program, "setFeaturePause")({ game: {} }, paused).accounts({ signer, pool }).instruction();
    case "jackpot":
      return method(program, "setFeaturePause")({ jackpot: {} }, paused).accounts({ signer, pool }).instruction();
    case "deploy":
      return method(program, "setDeployPause")(paused).accounts({ signer, pool }).instruction();
    case "buyTickets":
      return method(program, "setBuyTicketsPause")(paused).accounts({ admin: signer, pool }).instruction();
  }
}

/** One field per Option in the args: the program leaves a null one alone. */
function argsOf(fields: readonly Field[], changes: readonly Change[]): Record<string, number | BN | null> {
  const out: Record<string, number | BN | null> = {};
  for (const f of fields) {
    const c = changes.find((x) => x.key === f.key);
    out[f.key] = !c ? null : f.bits === "u16" ? Number(c.next) : new BN(c.next.toString());
  }
  return out;
}

export function setParamsIx(
  program: HexVaultProgram,
  admin: PublicKey,
  pool: PublicKey,
  changes: readonly Change[],
): Promise<TransactionInstruction> {
  return method(program, "setParams")(argsOf(PARAMS_FIELDS, changes)).accounts({ admin, pool }).instruction();
}

export function setVenueParamsIx(
  program: HexVaultProgram,
  admin: PublicKey,
  pool: PublicKey,
  changes: readonly Change[],
): Promise<TransactionInstruction> {
  return method(program, "setVenueParams")(argsOf(VENUE_FIELDS, changes)).accounts({ admin, pool }).instruction();
}

/** The Admin path of `grant_tickets`, uncapped. */
export function grantTicketsIx(
  program: HexVaultProgram,
  admin: PublicKey,
  pool: PublicKey,
  weightTree: PublicKey,
  owner: PublicKey,
  amount: bigint,
): Promise<TransactionInstruction> {
  return method(program, "grantTickets")(new BN(amount.toString()))
    .accounts({ signer: admin, pool, player: playerAddress(pool, owner), weightTree })
    .instruction();
}

/** Not Admin-gated: the signer pays from its own USDC account. */
export function fundJackpotIx(
  program: HexVaultProgram,
  wallet: PublicKey,
  pool: PublicKey,
  mint: PublicKey,
  amount: bigint,
): Promise<TransactionInstruction> {
  return method(program, "fundJackpot")(new BN(amount.toString()))
    .accounts({
      sourceAuthority: wallet,
      pool,
      acceptedMint: mint,
      source: acceptedAta(mint, wallet),
      jackpotVault: jackpotVaultAddress(pool),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/**
 * Same encoding as the CLI's `encodeForSquads`: an unsigned legacy
 * transaction, fee payer the Admin, base58 for Squads' "Import base58 encoded
 * tx". The blockhash expires in about a minute; Squads re-signs with its own.
 */
export function encodeForSquads(
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
  blockhash: string,
): string {
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  tx.add(...instructions);
  return utils.bytes.bs58.encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}
