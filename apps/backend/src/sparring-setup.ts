// docs/plan/sparring-player: bring the Sparring player up on one environment.
// Keypair, SOL, hexUSDC, one deposit. Every step checks the chain first, so a
// second run sends no transaction and prints why each step was skipped.
//
// A plain tsx script like ../bootstrap.ts rather than a Nest context: it signs
// with two keypairs (the authority funds, the Sparring wallet deposits) and
// ChainService only knows the authority.
//
// stdout carries the SPARRING_KEYPAIR line and nothing else, so
// `sparring-setup >> .env` appends a usable line; progress goes to stderr.
import { existsSync } from "node:fs";

import { AnchorProvider, BN, Program, Wallet } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { loadIdl } from "./chain/idl";
import { playerAddress, poolAddress, principalVaultAddress } from "./chain/pda";

/** 1000 hexUSDC. The mint has 6 decimals (spec.md §3.6, bootstrap.ts). */
const DEPOSIT = 1_000_000_000n;
const TOP_UP_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;
const MIN_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const hexusdc = (atomic: bigint): string => `${Number(atomic) / 1e6} hexUSDC`;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`missing required env var ${key}`);
  return value;
}

/** Names the failed step, same as bootstrap.ts. */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new Error(`sparring-setup failed while ${what}`, { cause });
  }
}

async function main(): Promise<void> {
  // Same file and precedence as Nest's ConfigModule: process.env wins.
  if (existsSync(".env")) process.loadEnvFile();

  const connection = new Connection(requireEnv("RPC_URL"), "confirmed");
  const authority = Keypair.fromSecretKey(
    bs58.decode(requireEnv("OPERATOR_KEYPAIR")),
  );
  const mint = new PublicKey(
    process.env.ACCEPTED_MINT ?? requireEnv("HEXUSDC_MINT"),
  );
  const programId = new PublicKey(requireEnv("PROGRAM_ID"));
  const poolId = BigInt(requireEnv("POOL_ID"));

  // Step 1. An absent SPARRING_KEYPAIR means the wallet does not exist yet;
  // the generated secret is printed once and never written to disk here.
  const configured = process.env.SPARRING_KEYPAIR;
  const sparring = configured
    ? Keypair.fromSecretKey(bs58.decode(configured))
    : Keypair.generate();
  if (configured) {
    log(`SPARRING_KEYPAIR is set; wallet ${sparring.publicKey.toBase58()}`);
  } else {
    log(
      `generated Sparring wallet ${sparring.publicKey.toBase58()}; paste the line on stdout into the env file`,
    );
    process.stdout.write(
      `SPARRING_KEYPAIR=${bs58.encode(sparring.secretKey)}\n`,
    );
  }
  log(
    // Host only: a keyed RPC URL carries its api key in the query string.
    `authority ${authority.publicKey.toBase58()} on ${new URL(connection.rpcEndpoint).host}`,
  );

  // The env-resolved program id wins over the checked-in IDL snapshot's
  // address, same as ChainService. The provider wallet is the Sparring
  // keypair, so the deposit below is signed and paid for by the Sparring
  // wallet rather than the authority.
  const idl = { ...loadIdl(), address: programId.toBase58() };
  const program = new Program(
    idl,
    new AnchorProvider(connection, new Wallet(sparring), {
      commitment: "confirmed",
    }),
  );

  // Existence only. The Pool is not decoded, so the script keeps working when
  // the deployed layout lags the IDL snapshot; a wrong ACCEPTED_MINT fails in
  // the deposit instead.
  const pool = poolAddress(programId, poolId);
  await step("reading the pool account", async () => {
    if (await connection.getAccountInfo(pool)) return;
    throw new Error(
      `pool ${pool.toBase58()} not found on this cluster; has bootstrap run?`,
    );
  });

  // Step 2. Fees and rent for weeks of hourly epochs.
  await step("topping up the Sparring wallet's SOL", async () => {
    const lamports = await connection.getBalance(sparring.publicKey);
    if (lamports >= MIN_LAMPORTS) {
      log(
        `skipped the SOL transfer: wallet holds ${lamports / LAMPORTS_PER_SOL} SOL`,
      );
      return;
    }
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: sparring.publicKey,
          lamports: TOP_UP_LAMPORTS,
        }),
      ),
      [authority],
      { commitment: "confirmed" },
    );
    log(
      `transferred ${TOP_UP_LAMPORTS / LAMPORTS_PER_SOL} SOL from the authority (wallet held ${lamports / LAMPORTS_PER_SOL})`,
    );
  });

  // The Player is read before the mint, not after it, because a completed
  // deposit leaves the token account at zero: minting on a balance check
  // alone would mint another 1000 on every re-run.
  const player = playerAddress(programId, pool, sparring.publicKey);
  const principal = await step("reading the Sparring Player", async () => {
    const info = await connection.getAccountInfo(player);
    if (!info) return 0n;
    // "player", not "Player": Program camelCases every IDL name, and decode
    // checks the discriminator, so a wrong account fails loudly here.
    const raw = program.coder.accounts.decode<{ principal: { toString(): string } }>(
      "player",
      info.data,
    );
    return BigInt(raw.principal.toString());
  });
  if (principal >= DEPOSIT) {
    log(
      `skipped the mint and the deposit: Player ${player.toBase58()} already holds ${hexusdc(principal)} of Principal`,
    );
    return;
  }

  // Step 3. Minting only works where this key is the mint authority, which
  // is the test mint and nothing else. On a real mint the wallet has to be
  // funded by hand first, so a wallet that is short stops the script here
  // rather than failing in the deposit with a token-program error.
  const tokenAccount = await step("funding the Sparring wallet", async () => {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      authority,
      mint,
      sparring.publicKey,
    );
    log(`token account ${ata.address.toBase58()} holds ${hexusdc(ata.amount)}`);
    if (ata.amount >= DEPOSIT) {
      log(`skipped the mint: the wallet already holds ${hexusdc(DEPOSIT)}`);
      return ata.address;
    }
    const info = await getMint(connection, mint);
    if (!info.mintAuthority?.equals(authority.publicKey)) {
      throw new Error(
        `mint ${mint.toBase58()} is controlled by ${info.mintAuthority?.toBase58() ?? "nobody"}, not by this key: send ${hexusdc(DEPOSIT)} to ${ata.address.toBase58()} and run this again`,
      );
    }
    await mintTo(
      connection,
      authority,
      mint,
      ata.address,
      authority,
      DEPOSIT,
    );
    log(`minted ${hexusdc(DEPOSIT)} with the authority key`);
    return ata.address;
  });

  // Step 4. init_if_needed on the Player, so this creates it when missing.
  await step("depositing", async () => {
    // The methods namespace of a generically typed Idl is an index signature,
    // so a stale IDL snapshot shows up here rather than as a call on undefined.
    const deposit = program.methods.deposit;
    if (!deposit) {
      throw new Error(
        "the IDL has no deposit instruction; run `pnpm --filter @hexvault/backend sync-idl`",
      );
    }
    const signature = await deposit(new BN(DEPOSIT.toString()))
      .accountsPartial({
        owner: sparring.publicKey,
        pool,
        player,
        acceptedMint: mint,
        ownerToken: tokenAccount,
        principalVault: principalVaultAddress(programId, pool),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log(
      `deposited ${hexusdc(DEPOSIT)} as ${sparring.publicKey.toBase58()} (Principal was ${hexusdc(principal)}), signature ${signature}`,
    );
  });
}

main().catch((error: unknown) => {
  // Print the whole cause chain: the outer message names the step, the
  // innermost names the RPC or program error.
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    log(
      e === error ? `sparring-setup: ${e.message}` : `  caused by: ${e.message}`,
    );
  }
  process.exitCode = 1;
});
