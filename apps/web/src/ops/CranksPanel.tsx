/**
 * Buttons for the permissionless cranks, signed by the connected wallet. Each
 * form builds its instructions at click time from a fresh read of the Pool
 * account (`instructions.ts`), so nothing here caches chain state.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PublicKey as Key } from "@solana/web3.js";
import { useState } from "react";

import type { HexVaultProgram } from "../chain.js";
import { pct, UNAVAILABLE, usdc } from "./format.js";
import {
  coverDeficit,
  deployToVenue,
  drainVenue,
  harvest,
  loadEpochSeed,
  loadPool,
  loadRoundSeed,
  migrateVenue,
  parseUsdcAmount,
  processWithdraw,
  recall,
  rolloverEpoch,
  voidRound,
  type VenuePool,
} from "./instructions.js";
import { useSendTx } from "./tx.js";
import { Panel, Row, useNow } from "./ui.js";
import { useOps } from "./useOps.js";
import { drainAccess, migrateAccess } from "./venueProposal.js";

type Build = (program: HexVaultProgram, pool: VenuePool, caller: PublicKey) => Promise<TransactionInstruction[]>;

const wrap =
  (one: (program: HexVaultProgram, pool: VenuePool, caller: PublicKey) => Promise<TransactionInstruction>): Build =>
  async (program, pool, caller) => [await one(program, pool, caller)];

export function CranksPanel() {
  const { summary: s } = useOps();
  const tx = useSendTx();
  const [amount, setAmount] = useState("");
  const [withdrawOwner, setWithdrawOwner] = useState("");
  const [note, setNote] = useState<string | null>(null);

  /** Reads the pool, builds, sends. Failures before the send land in `note`. */
  const run = async (build: Build) => {
    setNote(null);
    if (!tx.publicKey) return;
    try {
      const pool = await loadPool(tx.program);
      await tx.send(await build(tx.program, pool, tx.publicKey), pool.lookupTables);
    } catch (error) {
      console.error(error);
      setNote("Could not build the transaction. Check the figures and try again.");
    }
  };

  const parsed = parseUsdcAmount(amount);
  const ownerKey = (() => {
    try {
      return withdrawOwner.trim() ? new Key(withdrawOwner.trim()) : null;
    } catch {
      return null;
    }
  })();
  const off = !tx.ready || tx.pending;
  const stuckRound = s?.stuck?.round ?? null;
  const stuckEpoch = s?.stuck?.epoch ?? null;
  const now = useNow();
  const migrate = s ? migrateAccess(s, now) : null;
  const drain = s ? drainAccess(s, tx.publicKey?.toBase58() ?? null) : null;
  const hasDeficit = s !== null && BigInt(s.deficit) > 0n;
  const band = s?.venueParams
    ? `floor ${pct(s.venueParams.idleFloorBps)}, target ${pct(s.venueParams.idleTargetBps)}`
    : UNAVAILABLE;

  return (
    <Panel id="cranks" title="Cranks">
      {!tx.ready && <p className="ops-sync">Connect a wallet to act.</p>}
      <dl>
        <Row label="Free idle" value={s ? usdc(s.freeIdle) : UNAVAILABLE} />
        <Row label="Idle band" value={band} />
        <Row label="Fee owed" value={s ? usdc(s.feeOwed) : UNAVAILABLE} />
        <Row label="Prize owed" value={s ? usdc(s.prizeOwed) : UNAVAILABLE} />
      </dl>

      <label>
        Amount (USDC)
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          data-testid="crank-amount"
        />
      </label>
      <div className="ops-actions">
        <button
          type="button"
          disabled={off || parsed === null}
          onClick={() => parsed !== null && void run(async (p, pool) => [await deployToVenue(p, pool, parsed)])}
        >
          Deploy to venue
        </button>
        <button
          type="button"
          disabled={off || parsed === null}
          onClick={() => parsed !== null && void run(async (p, pool) => [await recall(p, pool, parsed)])}
        >
          Recall
        </button>
        <button
          type="button"
          data-testid="crank-drain"
          disabled={off || parsed === null || drain?.allowed !== true}
          onClick={() =>
            parsed !== null &&
            tx.publicKey &&
            void run(async (p, pool, caller) => [await drainVenue(p, pool, caller, parsed)])
          }
        >
          Drain venue
        </button>
        {hasDeficit && (
          <button
            type="button"
            disabled={off || parsed === null}
            onClick={() =>
              parsed !== null &&
              void run(async (p, pool, caller) => [await coverDeficit(p, pool, caller, parsed)])
            }
          >
            Cover deficit ({usdc(s?.deficit)})
          </button>
        )}
      </div>

      {drain && !drain.allowed && (
        <p className="ops-sync" data-testid="crank-drain-why">
          Drain venue is off. {drain.reason}
        </p>
      )}
      <div className="ops-actions">
        <button
          type="button"
          data-testid="crank-migrate"
          disabled={off || migrate?.allowed !== true}
          onClick={() => void run(wrap(migrateVenue))}
        >
          Migrate venue
        </button>
      </div>
      {migrate && !migrate.allowed && (
        <p className="ops-sync" data-testid="crank-migrate-why">
          Migrate venue is off. {migrate.reason}
        </p>
      )}
      <div className="ops-actions">
        <button
          type="button"
          data-testid="crank-harvest"
          disabled={off}
          onClick={() => void run(wrap(harvest))}
        >
          Harvest
        </button>
      </div>

      <label>
        Player wallet
        <input
          value={withdrawOwner}
          onChange={(e) => setWithdrawOwner(e.target.value)}
          placeholder="Wallet address"
          spellCheck={false}
        />
      </label>
      <div className="ops-actions">
        <button
          type="button"
          disabled={off || ownerKey === null}
          onClick={() =>
            ownerKey &&
            void run((p, pool, caller) => processWithdraw(p, pool, caller, ownerKey))
          }
        >
          Process withdraw
        </button>
      </div>

      <dl>
        <Row label="Stuck Round" value={stuckRound ? `#${stuckRound.id}` : "None"} />
        <Row label="Stuck epoch" value={stuckEpoch ? `#${stuckEpoch.id}` : "None"} />
      </dl>
      <div className="ops-actions">
        <button
          type="button"
          disabled={off || !stuckRound}
          onClick={() =>
            stuckRound &&
            void run(async (p, pool, caller) => [
              await voidRound(p, pool, caller, await loadRoundSeed(p, BigInt(stuckRound.id))),
            ])
          }
        >
          Void round
        </button>
        <button
          type="button"
          disabled={off || !stuckEpoch}
          onClick={() =>
            stuckEpoch &&
            void run(async (p, pool, caller) => [
              await rolloverEpoch(p, pool, caller, await loadEpochSeed(p, BigInt(stuckEpoch.id))),
            ])
          }
        >
          Roll over epoch
        </button>
      </div>

      {tx.pending && <p className="ops-sync">Waiting for the transaction to confirm.</p>}
      {tx.result && (
        <p data-testid="crank-result" role="status">
          Landed.{" "}
          <a href={tx.result.url} target="_blank" rel="noreferrer">
            {tx.result.signature.slice(0, 8)}...{tx.result.signature.slice(-8)}
          </a>
        </p>
      )}
      {(tx.error ?? note) && (
        <p className="ops-error" role="alert" data-testid="crank-error">
          {tx.error ?? note}
        </p>
      )}
    </Panel>
  );
}
