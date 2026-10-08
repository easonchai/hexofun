// `admin grant-tickets` (off-chain-tickets ticket 23): what it signs and posts,
// with no backend. The run against a real backend is in
// ../api/grants.controller.test.ts.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyGrant } from "../api/grants";
import { grantTickets, loadKeypairFile } from "./grant";

const TEAM = Keypair.generate();
const OWNER = Keypair.generate().publicKey;
const POOL = Keypair.generate().publicKey.toBase58();
const command = { kind: "grant-tickets", owner: OWNER, amount: 500n, reason: "launch bonus", keypair: "k.json" } as const;

afterEach(() => vi.restoreAllMocks());

describe("grantTickets", () => {
  it("posts a body the backend's verifier accepts and prints only the row id on stdout", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ id: "42" }), { status: 201 }));

    await grantTickets(command, TEAM, { pool: POOL, backendUrl: "http://b/", nowSeconds: 1_800_000_000.7, fetchFn });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://b/ops/grants");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ wallet: OWNER.toBase58(), amount: 500, reason: "launch bonus", signer: TEAM.publicKey.toBase58(), time: 1_800_000_000 });
    const verdict = verifyGrant({
      allowed: new Set([TEAM.publicKey.toBase58()]),
      signer: TEAM.publicKey,
      pool: POOL,
      wallet: sent.wallet,
      amount: sent.amount,
      reason: sent.reason,
      time: sent.time,
      signature: bs58.decode(sent.signature),
      nowSeconds: 1_800_000_000,
    });
    expect(verdict.ok).toBe(true);
    expect(stdout.mock.calls.map(([text]) => text)).toEqual(["42\n"]);
  });

  it("throws the backend's named refusal", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ code: "WalletNotListed", message: "no" }), { status: 403 }),
    );
    await expect(grantTickets(command, TEAM, { pool: POOL, backendUrl: "http://b", fetchFn })).rejects.toThrow(
      /HTTP 403.*WalletNotListed/,
    );
  });
});

describe("loadKeypairFile", () => {
  it("reads a solana keypair file and names a bad one", () => {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify([...TEAM.secretKey]));
    expect(loadKeypairFile(good).publicKey.toBase58()).toBe(TEAM.publicKey.toBase58());

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json");
    expect(() => loadKeypairFile(bad)).toThrow(/not a readable solana keypair/);
  });
});
