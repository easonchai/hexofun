/**
 * The send path every permissionless crank shares: read the Pool account,
 * build at click time, send through `useSendTx`, and report under the buttons.
 * Used by the routine cranks, the recovery cranks and the venue switch stepper.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { useState } from "react";

import type { HexVaultProgram } from "../chain.js";
import { loadPool, type VenuePool } from "./instructions.js";
import { useSendTx } from "./tx.js";

export type Build = (program: HexVaultProgram, pool: VenuePool, caller: PublicKey) => Promise<TransactionInstruction[]>;

export const wrap =
  (one: (program: HexVaultProgram, pool: VenuePool, caller: PublicKey) => Promise<TransactionInstruction>): Build =>
  async (program, pool, caller) => [await one(program, pool, caller)];

export function useCrank() {
  const tx = useSendTx();
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

  return { tx, run, note, off: !tx.ready || tx.pending };
}

/** Pending, landed and failed lines under a crank group. */
export function TxStatus({ crank }: { crank: ReturnType<typeof useCrank> }) {
  const { tx, note } = crank;
  return (
    <>
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
    </>
  );
}
