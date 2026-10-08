// spec.md §3.6: stand up a fresh pool on whatever cluster RPC_URL points at.
// Every step checks for the thing before creating it, so a second run creates
// nothing and prints the same block.
//
// Deliberately a plain tsx script, not a Nest standalone context: ConfigModule
// validates ACCEPTED_MINT as required at boot and this is the command that
// creates that mint, so a Nest context cannot start on a fresh cluster. It
// still imports the pure chain modules rather than re-deriving seeds.
//
// stdout carries only the KEY=value block; progress goes to stderr, so
// `bootstrap > pool.env` yields a pasteable file.
import { existsSync } from "node:fs";

import { AnchorProvider, BN, Program, Wallet, Idl } from "@anchor-lang/core";
import {
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { VENUE_KIND } from "./chain/venue-kind";

import {
  assertMainnetSafe,
  assertTokenAccountOwner,
  buyTicketsPausedFor,
  expectedVenuePins,
  parsePoolParams,
  venuePinsFor,
  type PoolParams,
  type VenuePins,
} from "./bootstrap/params";
import { assertPoolMatchesExpected } from "./boot-guard";
import { loadIdl } from "./chain/idl";
import {
  freeLeavesAddress,
  jackpotVaultAddress,
  playerAddress,
  poolAddress,
  principalVaultAddress,
  programDataAddress,
} from "./chain/pda";

/** spec.md §2.5. Pinned on the Pool; the localnet test-vrf build ignores it. */
const DEVNET_VRF_NETWORK_STATE = new PublicKey(
  "5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK",
);

const HEXUSDC_DECIMALS = 6;

/** `create_pool`'s Weight tree: discriminator plus the zero-copy header, a tree
 * with zero nodes (tests/helpers/hx.ts `WEIGHT_TREE_SPACE`). */
const WEIGHT_TREE_SPACE = 8 + 48;

/** Only the Pool fields this script reads back on a re-run. */
interface PoolAccount {
  admin: PublicKey;
  operator: PublicKey;
  acceptedMint: PublicKey;
  treasury: PublicKey;
  buybackReserve: PublicKey;
  weightTree: PublicKey;
  klendProgram: PublicKey;
  klendMarket: PublicKey;
  klendReserve: PublicKey;
  klendCtoken: PublicKey;
  venueKind: number;
  gamePaused: boolean;
  jackpotPaused: boolean;
  buyTicketsPaused: boolean;
}

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/** Malaysia is UTC+8 and skips daylight saving, so a fixed shift is exact. */
const stamp = (unixSeconds: number): string => {
  const utc = new Date(unixSeconds * 1000).toISOString();
  const myt = new Date((unixSeconds + 8 * 3600) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  return `${utc} (${myt} MYT)`;
};

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`missing required env var ${key}`);
  return value;
}

/** Names the failed step so a half-created pool says which half. */
async function step<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new Error(`bootstrap failed while ${what}`, { cause });
  }
}

/**
 * The mint is the one piece that must survive between runs, and this script
 * writes no keypair file, so `ACCEPTED_MINT` is the input whenever it is set
 * and a freshly generated mint is only printed for the caller to save.
 *
 * Creating one needs this key to be the mint authority; taking one that
 * already exists does not. Real USDC on mainnet has an authority nobody here
 * holds, and that is the normal case, not an error: it only means the faucet
 * and every other mint call stay off.
 */
async function ensureMint(
  connection: Connection,
  authority: Keypair,
  envMint: string | undefined,
): Promise<PublicKey> {
  if (!envMint) {
    const mint = await createMint(
      connection,
      authority,
      authority.publicKey,
      authority.publicKey,
      HEXUSDC_DECIMALS,
    );
    log(`created mint ${mint.toBase58()}`);
    return mint;
  }

  const mint = new PublicKey(envMint);
  const info = await getMint(connection, mint).catch((cause: unknown) => {
    throw new Error(
      `ACCEPTED_MINT ${envMint} is not a mint on this cluster; unset it to create a fresh one`,
      { cause },
    );
  });
  if (info.decimals !== HEXUSDC_DECIMALS) {
    throw new Error(
      `ACCEPTED_MINT ${envMint} has ${info.decimals} decimals, expected ${HEXUSDC_DECIMALS}`,
    );
  }
  if (!info.mintAuthority?.equals(authority.publicKey)) {
    log(
      `mint ${envMint} is controlled by ${info.mintAuthority?.toBase58() ?? "nobody"}, not by this key: no faucet, no minting`,
    );
    return mint;
  }
  log(`mint ${envMint} already exists`);
  return mint;
}

/**
 * Treasury and buyback_reserve share (mint, owner), so they cannot both be
 * the ATA. `createWithSeed` gives each a deterministic address instead of the
 * random keypair the test helper uses, which is what makes a re-run a no-op.
 * The seed carries the Pool PDA, not just POOL_ID: the same authority
 * bootstrapping pool 1 on a second program ID would otherwise land on the
 * first program's treasury, whose mint differs (MintMismatch in create_pool).
 */
async function ensureSeededTokenAccount(
  connection: Connection,
  authority: Keypair,
  mint: PublicKey,
  label: string,
  pool: PublicKey,
): Promise<PublicKey> {
  // Seeds cap at 32 bytes: "treasury-" plus 16 base58 chars of the pool.
  const seed = `${label}-${pool.toBase58().slice(0, 16)}`;
  const address = await PublicKey.createWithSeed(
    authority.publicKey,
    seed,
    TOKEN_PROGRAM_ID,
  );
  if (await connection.getAccountInfo(address)) {
    log(`${label} ${address.toBase58()} already exists`);
    return address;
  }

  const lamports =
    await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  const tx = new Transaction().add(
    SystemProgram.createAccountWithSeed({
      fromPubkey: authority.publicKey,
      basePubkey: authority.publicKey,
      seed,
      newAccountPubkey: address,
      lamports,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccount3Instruction(
      address,
      mint,
      authority.publicKey,
      TOKEN_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });
  log(`created ${label} ${address.toBase58()}`);
  return address;
}

/**
 * Takes an explicit `--treasury`/`--buyback-reserve` address as is, rather
 * than creating one: checked to exist and to hold the accepted mint, so a
 * typo'd address fails here instead of as an opaque MintMismatch inside
 * `create_pool`.
 */
async function ensureExplicitTokenAccount(
  connection: Connection,
  flag: string,
  address: PublicKey,
  mint: PublicKey,
  ownerCheck: { genesisHash: string; admin: PublicKey },
): Promise<PublicKey> {
  const account = await getAccount(connection, address).catch(
    (cause: unknown) => {
      throw new Error(
        `--${flag} ${address.toBase58()} is not a token account on this cluster`,
        { cause },
      );
    },
  );
  if (!account.mint.equals(mint)) {
    throw new Error(
      `--${flag} ${address.toBase58()} holds mint ${account.mint.toBase58()}, expected ${mint.toBase58()}`,
    );
  }
  assertTokenAccountOwner(
    ownerCheck.genesisHash,
    flag,
    address,
    account.owner,
    ownerCheck.admin,
  );
  return address;
}

async function createPool(
  program: Program<Idl>,
  payer: Keypair,
  roles: { admin: PublicKey; operator: PublicKey },
  poolId: bigint,
  pool: PublicKey,
  mint: PublicKey,
  treasury: PublicKey,
  buybackReserve: PublicKey,
  venue: VenuePins,
  params: PoolParams,
): Promise<void> {
  // The methods namespace of a generically typed Idl is an index signature,
  // so a stale IDL snapshot shows up here rather than as a decoding failure.
  const createPoolMethod = program.methods.createPool;
  if (!createPoolMethod) {
    throw new Error(
      "the IDL has no create_pool instruction; run `pnpm --filter @hexvault/backend sync-idl`",
    );
  }

  // A top-level create_account has to precede create_pool in the same
  // transaction: the program only fills the tree, it cannot allocate it. The
  // keypair is not kept, the Pool records the address.
  const weightTree = Keypair.generate();
  const connection = program.provider.connection;
  await createPoolMethod({
    poolId: new BN(poolId.toString()),
    admin: roles.admin,
    operator: roles.operator,
    vrfNetworkState: DEVNET_VRF_NETWORK_STATE,
    epochSeconds: new BN(params.epochSeconds),
    epochAnchor: new BN(params.epochAnchor),
    roundSeconds: new BN(params.roundSeconds),
    closeBuffer: new BN(params.closeBuffer),
    vrfTimeout: new BN(params.vrfTimeout),
    minDeposit: new BN(params.minDeposit.toString()),
    houseCutBps: params.houseCutBps,
    minJackpot: new BN(params.minJackpot.toString()),
    payoutTimeout: new BN(params.payoutTimeout),
    baseRateBps: params.baseRateBps,
    ticketsPerUsdc: params.ticketsPerUsdc,
    bonusCapBps: params.bonusCapBps,
    venueKind: venue.kind,
  })
    .accountsPartial({
      // create_pool takes only the program's upgrade authority as payer, so
      // bootstrap runs with the deploy key (mainnet-readiness-fixes 06).
      payer: payer.publicKey,
      programData: programDataAddress(program.programId),
      pool,
      acceptedMint: mint,
      principalVault: principalVaultAddress(program.programId, pool),
      jackpotVault: jackpotVaultAddress(program.programId, pool),
      house: playerAddress(program.programId, pool, roles.operator),
      treasury,
      buybackReserve,
      weightTree: weightTree.publicKey,
      freeLeaves: freeLeavesAddress(program.programId, pool),
      klendProgram: venue.klendProgram,
      klendMarket: venue.klendMarket,
      klendReserve: venue.klendReserve,
      klendCtoken: venue.klendCtoken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: weightTree.publicKey,
        space: WEIGHT_TREE_SPACE,
        lamports: await connection.getMinimumBalanceForRentExemption(WEIGHT_TREE_SPACE),
        programId: program.programId,
      }),
    ])
    .signers([payer, weightTree])
    .rpc();
  log(
    `created pool ${pool.toBase58()} (epoch ${params.epochSeconds}s, round ${params.roundSeconds}s)`,
  );
  // Print the grid the anchor produces, so a mistyped anchor is obvious now
  // rather than a week later when the draws land at the wrong hour.
  const now = Math.floor(Date.now() / 1000);
  const period = params.epochSeconds;
  // Math.floor matches Rust's div_euclid for a positive period, so an anchor
  // still in the future floors downward instead of toward zero.
  const next =
    params.epochAnchor +
    (Math.floor((now - params.epochAnchor) / period) + 1) * period;
  log(`  epoch anchor ${stamp(params.epochAnchor)}`);
  for (const k of [0, 1, 2]) {
    log(`  boundary ${k + 1} ${stamp(next + k * period)}`);
  }
}

/** `VENUE_KIND=stub`: creates the stub reserve and vault `venuePinsFor` pinned. */
async function initTestVenue(
  program: Program<Idl>,
  payer: Keypair,
  pool: PublicKey,
  mint: PublicKey,
  venue: VenuePins,
): Promise<void> {
  const testVenueInit = program.methods.testVenueInit;
  if (!testVenueInit) {
    throw new Error(
      "the IDL has no test_venue_init instruction; point HEXVAULT_IDL_PATH at a test-venue build's IDL",
    );
  }
  await testVenueInit()
    .accountsPartial({
      payer: payer.publicKey,
      pool,
      acceptedMint: mint,
      reserve: venue.klendReserve,
      venueVault: venue.klendCtoken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([payer])
    .rpc();
  log("initialised the test venue");
}

/**
 * game-jackpot-pause ticket 02: `--start`. Jackpot first, then game, the
 * order the spec asks for. Reads the pool first and sends only for a switch
 * still on, so a re-run starts nothing twice.
 */
async function startPool(
  program: Program<Idl>,
  admin: Keypair,
  pool: PublicKey,
): Promise<void> {
  const setFeaturePause = program.methods.setFeaturePause;
  if (!setFeaturePause) {
    throw new Error(
      "the IDL has no set_feature_pause instruction; run `pnpm --filter @hexvault/backend sync-idl`",
    );
  }
  const info = await program.provider.connection.getAccountInfo(pool);
  if (!info) throw new Error(`pool ${pool.toBase58()} not found after create_pool`);
  const state = program.coder.accounts.decode<PoolAccount>("pool", info.data);
  const switches = [
    { feature: "jackpot", paused: state.jackpotPaused },
    { feature: "game", paused: state.gamePaused },
  ];
  for (const { feature, paused } of switches) {
    if (!paused) {
      log(`${feature} already started`);
      continue;
    }
    await setFeaturePause({ [feature]: {} }, false)
      .accountsPartial({ signer: admin.publicKey, pool })
      .signers([admin])
      .rpc();
    log(`started the ${feature}`);
  }
}

/**
 * yield-claimer ticket 11: sets the Bought Tickets switch, admin only on
 * chain. Reads the pool first, so a re-run sends nothing twice.
 */
async function pauseBuyTickets(
  program: Program<Idl>,
  admin: Keypair,
  pool: PublicKey,
): Promise<void> {
  const setBuyTicketsPause = program.methods.setBuyTicketsPause;
  if (!setBuyTicketsPause) {
    throw new Error(
      "the IDL has no set_buy_tickets_pause instruction; run `pnpm --filter @hexvault/backend sync-idl`",
    );
  }
  const info = await program.provider.connection.getAccountInfo(pool);
  if (!info) throw new Error(`pool ${pool.toBase58()} not found after create_pool`);
  const state = program.coder.accounts.decode<PoolAccount>("pool", info.data);
  if (state.buyTicketsPaused) {
    log("Bought Tickets already paused");
    return;
  }
  await setBuyTicketsPause(true)
    .accountsPartial({ admin: admin.publicKey, pool })
    .signers([admin])
    .rpc();
  log("paused Bought Tickets");
}

async function main(): Promise<void> {
  // Same file and precedence as Nest's ConfigModule: process.env wins.
  if (existsSync(".env")) process.loadEnvFile();

  const params = parsePoolParams(process.argv.slice(2));
  const connection = new Connection(requireEnv("RPC_URL"), "confirmed");
  const authority = Keypair.fromSecretKey(
    bs58.decode(requireEnv("OPERATOR_KEYPAIR")),
  );
  // The loaded key pays, mints and owns the token accounts unless overridden.
  // `explicitAdmin` stays undefined when it would default to the hot key, so
  // the mainnet guard below can tell "given" from "defaulted".
  const explicitAdmin =
    params.admin ??
    (process.env.ADMIN_ADDRESS
      ? new PublicKey(process.env.ADMIN_ADDRESS)
      : undefined);
  const roles = {
    admin: explicitAdmin ?? authority.publicKey,
    operator: params.operator ?? authority.publicKey,
  };
  const programId = new PublicKey(requireEnv("PROGRAM_ID"));
  const poolId = BigInt(requireEnv("POOL_ID"));
  log(
    // Host only: a keyed RPC URL carries its api key in the query string.
    `signer ${authority.publicKey.toBase58()} on ${new URL(connection.rpcEndpoint).host}`,
  );
  log(
    `admin ${roles.admin.toBase58()}, operator ${roles.operator.toBase58()}`,
  );

  // spec.md: mainnet refuses every hot-key default. Read before anything is
  // created, so a forgotten flag costs nothing on mainnet.
  const envMint = process.env.ACCEPTED_MINT ?? process.env.HEXUSDC_MINT;
  const genesisHash = await step("reading the genesis hash", () =>
    connection.getGenesisHash(),
  );
  assertMainnetSafe({
    genesisHash,
    admin: explicitAdmin,
    operator: roles.operator,
    treasury: params.treasury,
    buybackReserve: params.buybackReserve,
    acceptedMint: envMint,
  });
  // game-jackpot-pause ticket 02: starting is admin only on chain, so a
  // --start this key cannot sign fails before anything is created.
  if (params.start && !roles.admin.equals(authority.publicKey)) {
    throw new Error(
      `--start needs the admin key, but the admin is ${roles.admin.toBase58()}; start the pool with the admin CLI's start-jackpot and start-game instead`,
    );
  }
  if (!explicitAdmin) {
    log(
      `warning: no --admin/ADMIN_ADDRESS given; defaulting Admin to the operator hot key ${authority.publicKey.toBase58()}`,
    );
  }
  if (!params.treasury) {
    log(
      "warning: no --treasury given; bootstrap will create one owned by the operator hot key",
    );
  }
  if (!params.buybackReserve) {
    log(
      "warning: no --buyback-reserve given; bootstrap will create one owned by the operator hot key",
    );
  }
  if (!envMint) {
    log(
      "warning: no ACCEPTED_MINT given; bootstrap will create a fresh mint controlled by the operator hot key",
    );
  }

  // The env-resolved program id wins over the checked-in IDL snapshot's
  // address, same as ChainService.
  const idl = { ...loadIdl(), address: programId.toBase58() };
  const program = new Program(
    idl,
    new AnchorProvider(connection, new Wallet(authority), {
      commitment: "confirmed",
    }),
  );

  const pool = poolAddress(programId, poolId);
  const existing = await step("reading the pool account", async () => {
    const info = await connection.getAccountInfo(pool);
    // "pool", not "Pool": Program camelCases every IDL name on construction.
    // `decode` checks the discriminator, so a wrong key fails loudly here.
    return info
      ? program.coder.accounts.decode<PoolAccount>("pool", info.data)
      : null;
  });
  if (existing && !existing.operator.equals(roles.operator)) {
    throw new Error(
      `pool ${pool.toBase58()} is cranked by ${existing.operator.toBase58()}, not by ${roles.operator.toBase58()}`,
    );
  }

  // An existing pool has already recorded which mint and which token accounts
  // it accepts, so those win over anything this run would otherwise derive.
  // But anyone can call create_pool on a program that does not yet protect it
  // (mainnet-readiness-fixes 06), so an existing pool must also match every
  // admin, treasury, buyback reserve, mint and venue pin this run was given,
  // or it may be someone else's.
  if (existing) {
    assertPoolMatchesExpected(
      pool,
      existing,
      {
        admin: explicitAdmin,
        treasury: params.treasury,
        buybackReserve: params.buybackReserve,
        acceptedMint: envMint ? new PublicKey(envMint) : undefined,
        venue: expectedVenuePins(genesisHash, process.env, pool, programId),
      },
      "the flags and env",
    );
  }
  // Read before anything is created, like the mainnet guard: a venue the env
  // does not name costs nothing here and a mint and two accounts later.
  const venue = existing
    ? null
    : venuePinsFor(genesisHash, process.env, pool, programId);
  const mint = existing
    ? existing.acceptedMint
    : await step("resolving the accepted mint", () =>
        ensureMint(connection, authority, envMint),
      );

  const authorityAta = await step(
    "creating the authority ATA",
    async () =>
      (
        await getOrCreateAssociatedTokenAccount(
          connection,
          authority,
          mint,
          authority.publicKey,
        )
      ).address,
  );

  const treasury = existing
    ? existing.treasury
    : params.treasury
      ? await step("checking --treasury", () =>
          ensureExplicitTokenAccount(connection, "treasury", params.treasury!, mint, {
            genesisHash,
            admin: roles.admin,
          }),
        )
      : await step("creating the treasury", () =>
          ensureSeededTokenAccount(
            connection,
            authority,
            mint,
            "treasury",
            pool,
          ),
        );
  const buybackReserve = existing
    ? existing.buybackReserve
    : params.buybackReserve
      ? await step("checking --buyback-reserve", () =>
          ensureExplicitTokenAccount(
            connection,
            "buyback-reserve",
            params.buybackReserve!,
            mint,
            { genesisHash, admin: roles.admin },
          ),
        )
      : await step("creating the buyback reserve", () =>
          ensureSeededTokenAccount(
            connection,
            authority,
            mint,
            "buyback",
            pool,
          ),
        );

  if (treasury.equals(buybackReserve)) {
    throw new Error("treasury and buyback reserve must differ");
  }

  if (!venue) {
    log(`pool ${pool.toBase58()} already exists`);
  } else {
    // The pool's cToken account is its ATA of the reserve's cToken mint, and
    // nothing else creates it before the first deploy.
    if (venue.ctokenMint) {
      const ctokenMint = venue.ctokenMint;
      await step("creating the pool's cToken account", () =>
        getOrCreateAssociatedTokenAccount(connection, authority, ctokenMint, pool, true),
      );
    }
    await step("calling create_pool", () =>
      createPool(
        program,
        authority,
        roles,
        poolId,
        pool,
        mint,
        treasury,
        buybackReserve,
        venue,
        params,
      ),
    );
    if (venue.kind === VENUE_KIND.stub) {
      await step("initialising the test venue", () =>
        initTestVenue(program, authority, pool, mint, venue),
      );
    }
  }
  // yield-claimer ticket 11: Bought Tickets ship paused on mainnet. Before
  // the game starts, so no Ticket is sold in between.
  if (buyTicketsPausedFor(genesisHash, process.env.BUY_TICKETS_PAUSED)) {
    if (roles.admin.equals(authority.publicKey)) {
      await step("pausing Bought Tickets", () =>
        pauseBuyTickets(program, authority, pool),
      );
    } else {
      log(
        `warning: Bought Tickets are still on; admin ${roles.admin.toBase58()} must send set_buy_tickets_pause(true) before launch`,
      );
    }
  }
  if (params.start) {
    await step("starting the jackpot and the game", () =>
      startPool(program, authority, pool),
    );
  } else if (!existing) {
    log("the game and the jackpot start paused; run the admin CLI's start-jackpot and start-game, or pass --start");
  }

  // The inline line above scrolls away behind create_pool's output, and a
  // wrong ACCEPTED_MINT on devnet costs a faucet and every mint call, so the
  // authority is repeated once more at the end where it is read.
  const mintAuthority = await step(
    "reading the mint authority",
    async () => (await getMint(connection, mint)).mintAuthority,
  );

  // What the chain pinned, not what this run asked for, so the venue can be
  // checked by a second person (yield-claimer ticket 17).
  const pinned = await step("reading the pool back", async () => {
    const info = await connection.getAccountInfo(pool);
    if (!info) throw new Error(`pool ${pool.toBase58()} not found`);
    return program.coder.accounts.decode<PoolAccount>("pool", info.data);
  });

  process.stdout.write(
    [
      `ACCEPTED_MINT=${mint.toBase58()}`,
      `MINT_AUTHORITY=${mintAuthority?.toBase58() ?? "none"}`,
      `PROGRAM_ID=${programId.toBase58()}`,
      `POOL_ID=${poolId}`,
      `POOL_ADDRESS=${pool.toBase58()}`,
      `PRINCIPAL_VAULT=${principalVaultAddress(programId, pool).toBase58()}`,
      `JACKPOT_VAULT=${jackpotVaultAddress(programId, pool).toBase58()}`,
      `TREASURY=${treasury.toBase58()}`,
      `BUYBACK_RESERVE=${buybackReserve.toBase58()}`,
      `AUTHORITY_ATA=${authorityAta.toBase58()}`,
      `WEIGHT_TREE=${pinned.weightTree.toBase58()}`,
      `KLEND_PROGRAM=${pinned.klendProgram.toBase58()}`,
      `KLEND_MARKET=${pinned.klendMarket.toBase58()}`,
      `KLEND_RESERVE=${pinned.klendReserve.toBase58()}`,
      `KLEND_CTOKEN=${pinned.klendCtoken.toBase58()}`,
      "",
    ].join("\n"),
  );

  if (!mintAuthority?.equals(authority.publicKey)) {
    log(
      `mint ${mint.toBase58()} is controlled by ${mintAuthority?.toBase58() ?? "nobody"}, not by ${authority.publicKey.toBase58()}: no faucet, no minting`,
    );
  }
}

main().catch((error: unknown) => {
  // Print the whole cause chain: the outer message names the step, the
  // innermost names the RPC or program error.
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    log(e === error ? `bootstrap: ${e.message}` : `  caused by: ${e.message}`);
  }
  process.exitCode = 1;
});
