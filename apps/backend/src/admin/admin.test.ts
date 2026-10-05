// The stdout/stderr contract of the admin CLI (runbook.md "Mainnet: the
// admin is a Squads multisig"): `admin ... | pbcopy` has to hand Squads one
// base58 transaction and nothing else, while every human-readable line goes
// to stderr. A wrong split here is invisible in a terminal, where both
// streams land on the same screen, and only shows up as a paste Squads
// rejects.
//
// The chain is a fake: `run` is driven directly, so no env is read, no
// connection is opened, and the instructions are the real ones built off the
// checked-in IDL.
import {
  AnchorProvider,
  BN,
  Program,
  Wallet,
  type Idl,
} from "@anchor-lang/core";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type AccountInfo,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChainService } from "../chain/chain.service";
import { loadIdl } from "../chain/idl";
import {
  jackpotVaultAddress,
  playerAddress,
  poolAddress,
  principalVaultAddress,
} from "../chain/pda";
import { createInvite, run, type InviteCodeStore } from "./index";
import type { AdminSigner } from "./ledger";
import type { AdminMode } from "./squads";

const PROGRAM_ID = new PublicKey("LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6");
const POOL = poolAddress(PROGRAM_ID, 1n);
const MINT = Keypair.generate().publicKey;
const BLOCKHASH = PublicKey.default.toBase58();

// Never reached: every account is passed explicitly, so Anchor resolves none.
const idl = { ...loadIdl(), address: PROGRAM_ID.toBase58() } as Idl;
const program = new Program(
  idl,
  new AnchorProvider(
    new Connection("http://127.0.0.1:1"),
    new Wallet(Keypair.generate()),
    {},
  ),
);

const bn = (value: bigint | number): BN => new BN(value.toString());

const poolFields = {
  poolId: bn(1),
  admin: Keypair.generate().publicKey,
  operator: Keypair.generate().publicKey,
  acceptedMint: MINT,
  principalVault: principalVaultAddress(PROGRAM_ID, POOL),
  jackpotVault: jackpotVaultAddress(PROGRAM_ID, POOL),
  treasury: Keypair.generate().publicKey,
  buybackReserve: Keypair.generate().publicKey,
  house: Keypair.generate().publicKey,
  vrfNetworkState: Keypair.generate().publicKey,
  epochSeconds: bn(86_400),
  epochAnchor: bn(1_789_315_200),
  roundSeconds: bn(60),
  closeBuffer: bn(5),
  vrfTimeout: bn(120),
  minDeposit: bn(1_000_000),
  paused: false,
  currentEpochId: bn(1),
  currentEpochStart: bn(0),
  currentEpochEndsAt: bn(0),
  previousEpochStart: bn(0),
  previousEpochEndsAt: bn(0),
  nextRoundId: bn(1),
  openRoundId: bn(0),
  totalPrincipal: bn(0),
  bump: 255,
  principalVaultBump: 254,
  jackpotVaultBump: 253,
};

/** A six-decimal mint account, for `withdraw-principal`'s `getMint`. */
function mintAccount(): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
}

/** An SPL token account holding `amount`, for the principal vault reads
 *  `principal-out`/`return-principal`/`emergency-crank` make. */
function tokenAccount(amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: MINT,
      owner: POOL,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      delegatedAmount: 0n,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  };
}

interface Harness {
  chain: ChainService;
  /** Instruction batches the local-mode path signed and sent. */
  sent: TransactionInstruction[][];
  /** Raw wire bytes `sendWithLedger` (ticket 09) handed to the connection. */
  rawSent: Buffer[];
}

interface HarnessOptions {
  /** Merged over the shared `poolFields` before encoding, for a test that
   *  needs a specific total_principal/pending_withdrawals/yield_budget. */
  pool?: Record<string, unknown>;
  /** Principal vault balance, atomic units; absent means the account does
   *  not exist (only `principal-out`/`return-principal`/`emergency-crank`
   *  read it). */
  vaultBalance?: bigint;
  /** Player accounts `emergency-crank`'s chain scan should find. */
  players?: readonly {
    owner: PublicKey;
    principal: bigint;
    pendingWithdraw: bigint;
    isHouse?: boolean;
  }[];
  /**
   * Player-shaped accounts placed at an address other than their claimed
   * owner's real PDA, the way a forged `owner` field would look on chain.
   * `playersOwedABalance`'s `pubkey.equals(chain.playerAddress(...))` check
   * (admin/index.ts) is what has to reject these before an ATA is ever
   * derived for the address they claim to own.
   */
  spoofedPlayers?: readonly { owner: PublicKey; principal: bigint; pendingWithdraw: bigint }[];
  /** Overrides the local-signing `chain.send` stub, for a test that needs a
   *  batch to fail partway through (emergency-crank's InsufficientVault). */
  send?: (instructions: TransactionInstruction[]) => Promise<string>;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const poolData = await program.coder.accounts.encode("pool", {
    ...poolFields,
    ...options.pool,
  });
  const principalVault = principalVaultAddress(PROGRAM_ID, POOL);
  const vaultInfo = options.vaultBalance === undefined ? null : tokenAccount(options.vaultBalance);
  const playerAccounts = await Promise.all(
    (options.players ?? []).map(async (player) => ({
      pubkey: playerAddress(PROGRAM_ID, POOL, player.owner),
      account: {
        data: await program.coder.accounts.encode("player", {
          owner: player.owner,
          principal: new BN(player.principal.toString()),
          pendingWithdraw: new BN(player.pendingWithdraw.toString()),
          isHouse: player.isHouse ?? false,
        }),
      },
    })),
  );
  const spoofedAccounts = await Promise.all(
    (options.spoofedPlayers ?? []).map(async (player) => ({
      // Deliberately NOT playerAddress(PROGRAM_ID, POOL, player.owner): a
      // forged account claiming someone else's owner would not land at
      // that owner's real PDA either.
      pubkey: Keypair.generate().publicKey,
      account: {
        data: await program.coder.accounts.encode("player", {
          owner: player.owner,
          principal: new BN(player.principal.toString()),
          pendingWithdraw: new BN(player.pendingWithdraw.toString()),
          isHouse: false,
        }),
      },
    })),
  );
  const sent: TransactionInstruction[][] = [];
  const rawSent: Buffer[] = [];
  const connection = {
    getAccountInfo: async (
      address: PublicKey,
    ): Promise<AccountInfo<Buffer> | null> => {
      if (address.equals(POOL)) {
        return {
          data: poolData,
          owner: PROGRAM_ID,
          executable: false,
          lamports: 1,
          rentEpoch: 0,
        };
      }
      if (address.equals(MINT)) return mintAccount();
      if (vaultInfo && address.equals(principalVault)) return vaultInfo;
      // The admin's token account: absent, so withdraw-principal has to
      // prepend its creation to the same transaction.
      return null;
    },
    // emergency-crank's own chain scan (admin/index.ts's playersOwedABalance);
    // the filters argument is not honoured, same as every other fake here
    // that trusts the real SDK to build the request correctly.
    getProgramAccounts: async () => [...playerAccounts, ...spoofedAccounts],
    getLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }),
    // Only the Ledger path (ticket 09) calls this; the plain local path
    // still goes through `chain.send` above.
    sendRawTransaction: async (raw: Buffer): Promise<string> => {
      rawSent.push(raw);
      return "ledger-signature";
    },
  };
  const chain = {
    program,
    programId: PROGRAM_ID,
    keypair: Keypair.generate(),
    poolId: 1n,
    connection,
    poolAddress: () => POOL,
    principalVaultAddress: () => principalVault,
    jackpotVaultAddress: () => jackpotVaultAddress(PROGRAM_ID, POOL),
    playerAddress: (owner: PublicKey) => playerAddress(PROGRAM_ID, POOL, owner),
    send:
      options.send ??
      (async (instructions: TransactionInstruction[]): Promise<string> => {
        sent.push(instructions);
        return "signature";
      }),
    // Only the Ledger path (ticket 09/04) calls this; a test overrides it to
    // simulate an on-chain failure the way it used to override
    // `connection.confirmTransaction`.
    sendSigned: async (raw: Buffer): Promise<void> => {
      await connection.sendRawTransaction(raw);
    },
  } as unknown as ChainService;
  return { chain, sent, rawSent };
}

/**
 * A Ledger stand-in: signs with a real (software) keypair rather than
 * hardware, so `sendWithLedger`'s `signed.serialize()` sees a real signature
 * and does not reject it the way it would an all-zero placeholder. The point
 * under test is `submit`'s wiring, not where the signature came from.
 */
function fakeLedger(keypair: Keypair): AdminSigner {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(keypair);
      return tx;
    },
  };
}

/** Everything the two streams received while `body` ran, as lines. */
async function capture(body: () => Promise<void>): Promise<{
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const collect = (into: string[]) =>
    vi.fn((chunk: string | Uint8Array) => {
      into.push(String(chunk));
      return true;
    });
  const outSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(collect(stdout));
  const errSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(collect(stderr));
  try {
    await body();
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const lines = (chunks: string[]): string[] =>
    chunks.join("").split("\n").filter((line) => line.length > 0);
  return { stdout: lines(stdout), stderr: lines(stderr) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin run", () => {
  it("set-params in local mode signs, and writes nothing to stdout", async () => {
    const { chain, sent } = await harness();
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    const { stdout, stderr } = await capture(() =>
      run({ kind: "set-params", params: { epochSeconds: 3_600 } }, chain, mode),
    );

    expect(sent).toHaveLength(1);
    expect(stdout).toEqual([]);
    // The signature is a log line like any other, so it belongs on stderr.
    expect(stderr[0]).toMatch(/^signature /);
    expect(stderr).toHaveLength(2);
  });

  it("unpause in multisig mode prints one base58 transaction and nothing else", async () => {
    const { chain, sent } = await harness();
    const multisigVault = Keypair.generate().publicKey;
    const mode: AdminMode = { signer: multisigVault, multisig: true };

    const { stdout, stderr } = await capture(() =>
      run({ kind: "unpause" }, chain, mode),
    );

    // Nothing signed: the key is not in this process.
    expect(sent).toEqual([]);
    expect(stdout).toHaveLength(1);
    const tx = Transaction.from(bs58.decode(stdout[0] as string));
    // Squads signs it; every slot has to still be empty on the way out.
    expect(tx.signatures.every((entry) => entry.signature === null)).toBe(true);
    expect(tx.feePayer?.equals(multisigVault)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.instructions).toHaveLength(1);
    // The multisig vault, not the loaded key, is what the program checks.
    expect(
      tx.instructions[0]?.keys.some(
        (key) => key.isSigner && key.pubkey.equals(multisigVault),
      ),
    ).toBe(true);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("grant-tickets in local mode signs with the loaded key as the admin path", async () => {
    const { chain, sent } = await harness();
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };
    const owner = Keypair.generate().publicKey;

    const { stdout, stderr } = await capture(() =>
      run({ kind: "grant-tickets", owner, amount: 500n }, chain, mode),
    );

    expect(sent).toHaveLength(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(`grant 500 tickets to ${owner.toBase58()} (admin path, uncapped)`);
  });

  it("grant-tickets in multisig mode prints one base58 transaction signed by the multisig vault", async () => {
    const { chain, sent } = await harness();
    const multisigVault = Keypair.generate().publicKey;
    const mode: AdminMode = { signer: multisigVault, multisig: true };
    const owner = Keypair.generate().publicKey;

    const { stdout } = await capture(() =>
      run({ kind: "grant-tickets", owner, amount: 500n }, chain, mode),
    );

    expect(sent).toEqual([]);
    expect(stdout).toHaveLength(1);
    const tx = Transaction.from(bs58.decode(stdout[0] as string));
    expect(tx.feePayer?.equals(multisigVault)).toBe(true);
    expect(
      tx.instructions[0]?.keys.some(
        (key) => key.isSigner && key.pubkey.equals(multisigVault),
      ),
    ).toBe(true);
  });

  it("set-params in local mode carries the base yield and ticket-economy flags", async () => {
    const { chain, sent } = await harness();
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    await run(
      {
        kind: "set-params",
        params: { baseRateBps: 488, ticketsPerUsdc: 10, bonusCapBps: 500 },
      },
      chain,
      mode,
    );

    expect(sent).toHaveLength(1);
  });

  it("unpause with a Ledger signer sends through the Ledger, not chain.send (ticket 09)", async () => {
    const { chain, sent, rawSent } = await harness();
    const ledgerKeypair = Keypair.generate();
    const mode: AdminMode = { signer: ledgerKeypair.publicKey, multisig: false };

    const { stdout, stderr } = await capture(() =>
      run({ kind: "unpause" }, chain, mode, fakeLedger(ledgerKeypair)),
    );

    // Never reaches chain.send: the Ledger path builds and sends its own
    // transaction straight off chain.connection, through chain.sendSigned.
    expect(sent).toEqual([]);
    expect(rawSent).toHaveLength(1);
    const tx = Transaction.from(rawSent[0] as Buffer);
    expect(tx.feePayer?.equals(ledgerKeypair.publicKey)).toBe(true);
    // SAFETY: `sendWithLedger` fills this from the same bytes just asserted on.
    const expectedSignature = bs58.encode(tx.signature as Buffer);
    expect(stdout).toEqual([]);
    expect(stderr).toContain("confirm on the Ledger");
    expect(stderr).toContain(`signature ${expectedSignature}`);
  });

  it("a Ledger send that lands but fails on-chain throws instead of reporting success", async () => {
    const { chain } = await harness();
    chain.sendSigned = async () => {
      throw new Error('transaction ledger-signature failed: {"Custom":6000}');
    };
    const ledgerKeypair = Keypair.generate();
    const mode: AdminMode = { signer: ledgerKeypair.publicKey, multisig: false };

    await expect(
      capture(() => run({ kind: "unpause" }, chain, mode, fakeLedger(ledgerKeypair))),
    ).rejects.toThrow(/transaction .* failed/);
  });

  // game-jackpot-pause ticket 02.
  it("pause-game signs locally with the loaded key", async () => {
    const { chain, sent } = await harness();
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    const { stderr } = await capture(() => run({ kind: "pause-game" }, chain, mode));

    expect(sent).toHaveLength(1);
    expect(stderr).toContain("game paused");
  });

  // yield-claimer ticket 10.
  it("pause-deploy signs locally with the loaded key, the operator's included", async () => {
    const { chain, sent } = await harness();
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    const { stderr } = await capture(() => run({ kind: "pause-deploy" }, chain, mode));

    expect(sent).toHaveLength(1);
    expect(stderr).toContain("deploy paused");
  });

  it("start-deploy refuses an operator signer before sending", async () => {
    const { chain, sent, rawSent } = await harness();
    const mode: AdminMode = { signer: poolFields.operator, multisig: false };

    await expect(
      capture(() => run({ kind: "start-deploy" }, chain, mode)),
    ).rejects.toThrow(/start-deploy is admin only: .* is the operator/);
    expect(sent).toEqual([]);
    expect(rawSent).toEqual([]);
  });

  it("start-deploy in multisig mode prints one base58 transaction signed by the admin", async () => {
    const multisigVault = Keypair.generate().publicKey;
    const { chain, sent } = await harness({ pool: { admin: multisigVault } });
    const mode: AdminMode = { signer: multisigVault, multisig: true };

    const { stdout } = await capture(() => run({ kind: "start-deploy" }, chain, mode));

    expect(sent).toEqual([]);
    expect(stdout).toHaveLength(1);
    const tx = Transaction.from(bs58.decode(stdout[0] as string));
    expect(tx.feePayer?.equals(multisigVault)).toBe(true);
  });

  it("start-jackpot refuses an operator signer before sending", async () => {
    const { chain, sent, rawSent } = await harness();
    const mode: AdminMode = { signer: poolFields.operator, multisig: false };

    await expect(
      capture(() => run({ kind: "start-jackpot" }, chain, mode)),
    ).rejects.toThrow(/admin only: .* is the operator/);
    expect(sent).toEqual([]);
    expect(rawSent).toEqual([]);
  });

  it("start-game in multisig mode prints one base58 transaction signed by the admin", async () => {
    const multisigVault = Keypair.generate().publicKey;
    const { chain, sent } = await harness({ pool: { admin: multisigVault } });
    const mode: AdminMode = { signer: multisigVault, multisig: true };

    const { stdout } = await capture(() => run({ kind: "start-game" }, chain, mode));

    expect(sent).toEqual([]);
    expect(stdout).toHaveLength(1);
    const tx = Transaction.from(bs58.decode(stdout[0] as string));
    expect(tx.feePayer?.equals(multisigVault)).toBe(true);
  });

  it("start-jackpot with a Ledger admin sends through the Ledger", async () => {
    const ledgerKeypair = Keypair.generate();
    const { chain, sent, rawSent } = await harness({
      pool: { admin: ledgerKeypair.publicKey },
    });
    const mode: AdminMode = { signer: ledgerKeypair.publicKey, multisig: false };

    await capture(() =>
      run({ kind: "start-jackpot" }, chain, mode, fakeLedger(ledgerKeypair)),
    );

    expect(sent).toEqual([]);
    expect(rawSent).toHaveLength(1);
  });

  it("shutdown refuses unless --confirm matches the configured pool, irreversible or not", async () => {
    const { chain, sent } = await harness();
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    await expect(
      capture(() => run({ kind: "shutdown", confirm: 99n }, chain, mode)),
    ).rejects.toThrow(/does not match the configured pool/);
    expect(sent).toEqual([]);
  });

  it("shutdown in local mode sends once --confirm matches the pool id", async () => {
    const { chain, sent } = await harness();
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    await run({ kind: "shutdown", confirm: 1n }, chain, mode);
    expect(sent).toHaveLength(1);
  });

  it("emergency-crank pays every Player owed a balance, creating each owner's ATA idempotently", async () => {
    const alice = Keypair.generate().publicKey;
    const bob = Keypair.generate().publicKey;
    const { chain, sent } = await harness({
      players: [
        { owner: alice, principal: 1_000_000n, pendingWithdraw: 0n },
        { owner: bob, principal: 0n, pendingWithdraw: 500_000n },
      ],
    });
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    const { stdout, stderr } = await capture(() =>
      run({ kind: "emergency-crank", batch: 5 }, chain, mode),
    );

    // One batch (2 players, batch size 5): an idempotent ATA create plus
    // emergency_withdraw per player.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(4);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain("paid 2, skipped 0");
  });

  it("emergency-crank skips the House and a Player owed nothing", async () => {
    const house = Keypair.generate().publicKey;
    const zero = Keypair.generate().publicKey;
    const { chain, sent } = await harness({
      players: [
        { owner: house, principal: 1_000_000n, pendingWithdraw: 0n, isHouse: true },
        { owner: zero, principal: 0n, pendingWithdraw: 0n },
      ],
    });
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    const { stderr } = await capture(() =>
      run({ kind: "emergency-crank", batch: 5 }, chain, mode),
    );
    expect(sent).toEqual([]);
    expect(stderr.join("\n")).toContain("no Player owes a balance");
  });

  it("emergency-crank ignores a Player-shaped account that is not at its claimed owner's real PDA (a spoofed account)", async () => {
    const attacker = Keypair.generate().publicKey;
    const alice = Keypair.generate().publicKey;
    const { chain, sent } = await harness({
      players: [{ owner: alice, principal: 1_000_000n, pendingWithdraw: 0n }],
      spoofedPlayers: [{ owner: attacker, principal: 1_000_000n, pendingWithdraw: 0n }],
    });
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    const { stderr } = await capture(() =>
      run({ kind: "emergency-crank", batch: 5 }, chain, mode),
    );

    // Only Alice's real Player is paid; the spoofed account never gets an
    // ATA derived for it or an emergency_withdraw built against it.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    const keys = sent[0]?.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58())) ?? [];
    expect(keys).not.toContain(attacker.toBase58());
    expect(stderr.join("\n")).toContain("paid 1, skipped 0");
  });

  it("emergency-crank stops at the first InsufficientVault and prints the vault balance", async () => {
    const alice = Keypair.generate().publicKey;
    const { chain, sent } = await harness({
      pool: {
        totalPrincipal: new BN(1_000_000),
        pendingWithdrawals: new BN(0),
      },
      vaultBalance: 500_000n,
      players: [{ owner: alice, principal: 1_000_000n, pendingWithdraw: 0n }],
      send: async () => {
        throw new Error("InsufficientVault");
      },
    });
    const mode: AdminMode = { signer: chain.keypair.publicKey, multisig: false };

    const { stderr } = await capture(() =>
      run({ kind: "emergency-crank", batch: 5 }, chain, mode),
    );

    expect(sent).toEqual([]);
    const lines = stderr.join("\n");
    expect(lines).toContain("insufficient vault");
    expect(lines).toContain("principal vault holds 500000");
    expect(lines).toContain("paid 0, skipped 1");
  });

  it("sweep-house in local mode signs, and multisig mode prints one transaction", async () => {
    const local = await harness();
    const localMode: AdminMode = { signer: local.chain.keypair.publicKey, multisig: false };
    await run({ kind: "sweep-house" }, local.chain, localMode);
    expect(local.sent).toHaveLength(1);

    const multisig = await harness();
    const multisigVault = Keypair.generate().publicKey;
    const multisigMode: AdminMode = { signer: multisigVault, multisig: true };
    const { stdout } = await capture(() =>
      run({ kind: "sweep-house" }, multisig.chain, multisigMode),
    );
    expect(multisig.sent).toEqual([]);
    expect(stdout).toHaveLength(1);
  });
});

interface CreatedInvite {
  code: string;
  ownerWallet: string | null;
  maxUses: number;
  uses: number;
  createdAt: bigint;
}

/** An in-memory stand-in for the one Prisma call `createInvite` makes, so
 *  this exercises the real dispatch logic without a database. */
function fakeInviteStore(): { store: InviteCodeStore; created: CreatedInvite[] } {
  const created: CreatedInvite[] = [];
  return {
    store: {
      inviteCode: {
        create: async ({ data }) => {
          created.push(data);
          return data;
        },
      },
    },
    created,
  };
}

describe("createInvite", () => {
  it("writes one code per --count to the store and prints each on stdout", async () => {
    const { store, created } = fakeInviteStore();
    const owner = Keypair.generate().publicKey;

    const { stdout, stderr } = await capture(() =>
      createInvite(store, { kind: "create-invite", maxUses: 5, count: 3, owner }),
    );

    expect(created).toHaveLength(3);
    expect(new Set(created.map((row) => row.code)).size).toBe(3);
    for (const row of created) {
      expect(row.code).toHaveLength(8);
      expect(row.ownerWallet).toBe(owner.toBase58());
      expect(row.maxUses).toBe(5);
      expect(row.uses).toBe(0);
    }
    expect(stdout).toHaveLength(3);
    expect(stderr).toEqual([]);
  });

  it("stores no owner when --owner is not given", async () => {
    const { store, created } = fakeInviteStore();
    await createInvite(store, { kind: "create-invite", maxUses: 1, count: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]?.ownerWallet).toBeNull();
  });
});
