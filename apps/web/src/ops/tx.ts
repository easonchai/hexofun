/**
 * Send, confirm and report one Ops console transaction, signed by the
 * connected wallet. Shared by the crank, Admin and Fast pause panels.
 *
 *   const { send, pending, result, error } = useSendTx();
 *   const signature = await send([ix]);   // string on landed, null otherwise
 *
 * `send` reuses the player app's `sendMany` (compute budget from a simulation,
 * blockhash-strategy confirm, unknown outcomes polled to a verdict). On a
 * landed transaction it calls `useOps().refresh()`. A failure never throws:
 * `error` carries the program's error name, for example `NothingToHarvest`.
 * `result` is `{ signature, url }` for the last landed send. `pending` is true
 * while one is in flight, and a second `send` during that time is ignored.
 */
import { AnchorProvider, Program } from "@anchor-lang/core";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  awaitSendResult,
  sendMany,
  type ResolvedSendResult,
} from "../actions.js";
import { CLUSTER, PROGRAM_ID, RPC_URL, type HexVaultProgram } from "../chain.js";
import type { Cluster } from "../cluster.js";
import { idl } from "../idl.js";
import { extractCode } from "../playerErrors.js";
import { useOps } from "./useOps.js";

/** Priority fee floor from `safePriorityFee`; the console reads no fee estimate. */
const PRIORITY_FEE_MICROLAMPORTS = 1_000;

const NAME_BY_CODE = new Map((idl.errors ?? []).map((e) => [e.code, e] as const));

/** "NothingToHarvest: <the program's own message>", or a plain fallback. */
export function errorText(code: number | null): string {
  if (code === null) return "The transaction failed. See the browser console for the raw error.";
  const entry = NAME_BY_CODE.get(code);
  return entry ? `${entry.name}: ${entry.msg}` : `Program error ${code}`;
}

/** Text for a failed or expired send, or for something thrown before it landed. */
export function failureText(
  failure: { kind: "expired" } | { kind: "failed"; code: number | null } | { kind: "thrown"; error: unknown },
): string {
  if (failure.kind === "expired") return "The transaction expired before it confirmed. Try again.";
  if (failure.kind === "failed") return errorText(failure.code);
  const text = failure.error instanceof Error ? failure.error.message : String(failure.error);
  if (/reject|denied|cancel/i.test(text) && extractCode(text) === null) {
    return "The wallet declined the request.";
  }
  return errorText(extractCode(text));
}

const isLocal = (rpcUrl: string): boolean => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl);

/**
 * Solana Explorer link for a signature. The cluster follows `VITE_CLUSTER`,
 * except a localhost RPC, which goes through the explorer's custom-URL mode.
 */
export function explorerTxUrl(
  signature: string,
  cluster: Cluster = CLUSTER,
  rpcUrl: string = RPC_URL,
): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (isLocal(rpcUrl)) return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  return cluster === "mainnet-beta" ? base : `${base}?cluster=${cluster}`;
}

export interface SendState {
  /** Sends `ixs` and resolves to the signature, or null after setting `error`. */
  send: (ixs: TransactionInstruction[]) => Promise<string | null>;
  pending: boolean;
  /** The last landed send. Cleared when the next one starts. */
  result: { signature: string; url: string } | null;
  /** The last failure's text. Cleared when the next send starts. */
  error: string | null;
  /** True when a wallet is connected, so a button can disable on `!ready || pending`. */
  ready: boolean;
  /** The connected wallet, or null. */
  publicKey: PublicKey | null;
  /** A Program on the console's connection and wallet, for builders that read accounts. */
  program: HexVaultProgram;
}

export function useProgram(): HexVaultProgram {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  return useMemo(() => {
    const wallet = {
      publicKey: publicKey ?? undefined,
      signTransaction: signTransaction ?? (() => Promise.reject(new Error("wallet cannot sign"))),
      signAllTransactions: signAllTransactions ?? (() => Promise.reject(new Error("wallet cannot sign"))),
    };
    const provider = new AnchorProvider(connection, wallet as never, { commitment: "confirmed" });
    // The IDL's baked-in address is the dev program; PROGRAM_ID is the build's.
    return new Program({ ...idl, address: PROGRAM_ID.toBase58() }, provider) as unknown as HexVaultProgram;
  }, [connection, publicKey, signTransaction, signAllTransactions]);
}

export function useSendTx(): SendState {
  const program = useProgram();
  const { publicKey } = useWallet();
  const { refresh } = useOps();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SendState["result"]>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const send = useCallback(
    async (ixs: TransactionInstruction[]): Promise<string | null> => {
      if (busy.current || !publicKey) return null;
      busy.current = true;
      setPending(true);
      setResult(null);
      setError(null);
      try {
        const first = await sendMany(program, { publicKey }, ixs, PRIORITY_FEE_MICROLAMPORTS);
        const outcome: ResolvedSendResult = await awaitSendResult(program, first);
        if (outcome.kind === "landed") {
          setResult({ signature: outcome.signature, url: explorerTxUrl(outcome.signature) });
          await refresh();
          return outcome.signature;
        }
        if (outcome.kind === "failed") console.error(outcome.message);
        setError(failureText(outcome));
      } catch (thrown) {
        console.error(thrown);
        setError(failureText({ kind: "thrown", error: thrown }));
      } finally {
        busy.current = false;
        setPending(false);
      }
      return null;
    },
    [program, publicKey, refresh],
  );

  return { send, pending, result, error, ready: publicKey !== null, publicKey, program };
}
