// A fake `Connection` that tallies calls per RPC method, so a suite can
// assert a ceiling instead of trusting that a poll was removed (ticket 03,
// spec.md "A shared counting connection is the new seam"). Started as the
// operator service suite's own inline `FakeConnection`
// (`getMultipleAccountsInfo` only, keyed by base58 address); this is that
// same shape, shared, with the tally added and `getAccountInfo` (the VRF
// fulfilled check, and every `getAccount`/token read that goes through it).
//
// Tickets 04 and 05 import this too: 04 to assert a send costs at most two
// calls and awaiting randomness costs none, 05 to assert the paginated sweep
// costs one call quiet and seven for a full walk. Extend it with the methods
// those need (`getProgramAccounts`, `onLogs`, ...) rather than adding a
// second counting fake.
//
// Ticket 04 added the subscription and send-confirmation methods below
// (`onSignature`, `onAccountChange`, `getSignatureStatuses`, `getBlockHeight`,
// `getLatestBlockhash`, `sendRawTransaction`), plus `fireLogs`/
// `fireAccountChange` test hooks so a suite can simulate the RPC pushing a
// notification instead of waiting on a real subscription.
//
// Ops-and-envs ticket 10 added `getRecentPrioritizationFees`, which
// `ChainService.send` now calls on every send to price its priority fee.
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/** Shape `onLogs`'s callback receives; mirrors web3.js's `Logs`. */
interface FakeLogs {
  err: unknown;
  logs: string[];
  signature: string;
}

/** The slice of a `getTransaction` answer the indexer reads. */
interface FakeTransaction {
  meta: { logMessages: string[] };
  transaction: { message: { getAccountKeys: () => { keySegments: () => PublicKey[][] } } };
}

export class CountingConnection {
  private readonly calls = new Map<string, number>();
  private readonly lastCallParams = new Map<string, unknown[]>();
  /** `context.slot` every call that reports one (e.g. `getProgramAccountsV2`) answers with. */
  slot = 100;
  /** Accounts served per `getProgramAccountsV2` page; 1,000 on the real RPC. */
  pageSize = 1_000;
  /** Addresses `onLogs`/`getSignaturesForAddress` were asked to watch or list. */
  watched: PublicKey[] = [];
  /** When set, the call whose 1-based per-method count matches throws, so a
   *  test can exercise a page (or send) failure mid-sequence. */
  failOnCallNumber: { method: string; number: number } | undefined;
  /** Answers `getProgramAccountsV2` with JSON-RPC -32601, the way a local
   *  validator and every non-Helius provider does. */
  noProgramAccountsV2 = false;
  /** Height `getBlockHeight` answers with `send`'s expiry fallback checks. */
  blockHeight = 0;
  /** Whether `sendRawTransaction` lands the transaction, notifying the
   *  `onSignature` listeners already open, as the RPC does (default: yes, with
   *  no error). A listener opened after the send hears nothing, which is the
   *  race `ChainService.send` has to avoid. False lets a test drive the
   *  bounded timeout fallback instead. */
  autoConfirmSignature = true;
  /** Error the landing notification reports, when `autoConfirmSignature`. */
  signatureError: unknown = null;
  private signatureListeners: ((result: { err: unknown }) => void)[] = [];
  /** Status `getSignatureStatuses` answers with once the wait times out;
   *  undefined ("not found") sends `send`'s fallback on to `getBlockHeight`. */
  signatureStatus: { err: unknown } | undefined;
  private readonly logsListeners: {
    address: PublicKey;
    commitment: string | undefined;
    callback: (logs: FakeLogs, context: { slot: number }) => void;
  }[] = [];
  private readonly accountChangeListeners = new Map<
    string,
    (info: { data: Buffer }) => void
  >();

  constructor(private readonly accounts: Map<string, Buffer> = new Map()) {}

  /** Account bytes `getMultipleAccountsInfo`/`getAccountInfo` will answer with. */
  setAccount(address: PublicKey, data: Buffer): void {
    this.accounts.set(address.toBase58(), data);
  }

  deleteAccount(address: PublicKey): void {
    this.accounts.delete(address.toBase58());
  }

  /** Drops every account, e.g. to simulate an incremental result reporting
   *  nothing (a quiet sweep) or only a specific caller's next `setAccount`. */
  clearAccounts(): void {
    this.accounts.clear();
  }

  /** Calls made to `method` since construction or the last `resetCalls()`. */
  callsTo(method: string): number {
    return this.calls.get(method) ?? 0;
  }

  /** Every tallied method at once, for a assert-the-whole-shape check. */
  callCounts(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.calls);
  }

  /** The params the most recent call to `method` was made with, so a test
   *  can check what was asked for (e.g. `changedSinceSlot`), not just the tally. */
  lastParams(method: string): unknown[] | undefined {
    return this.lastCallParams.get(method);
  }

  resetCalls(): void {
    this.calls.clear();
    this.lastCallParams.clear();
  }

  /** Tallies the call and returns the method's new count, so a caller that
   *  wants to honour `failOnCallNumber` (`_rpcRequest` does) can reject
   *  instead of throwing synchronously out of a `Promise`-returning method. */
  private record(method: string, params?: unknown[]): number {
    const count = (this.calls.get(method) ?? 0) + 1;
    this.calls.set(method, count);
    if (params !== undefined) this.lastCallParams.set(method, params);
    return count;
  }

  /** Owner every served account reports; a suite that reads it sets the program id. */
  accountOwner: PublicKey = PublicKey.default;

  getMultipleAccountsInfo(
    keys: PublicKey[],
  ): Promise<({ data: Buffer; owner: PublicKey } | null)[]> {
    this.record("getMultipleAccountsInfo");
    return Promise.resolve(
      keys.map((key) => {
        const data = this.accounts.get(key.toBase58());
        return data ? { data, owner: this.accountOwner } : null;
      }),
    );
  }

  getAccountInfo(key: PublicKey): Promise<{ data: Buffer } | null> {
    this.record("getAccountInfo");
    const data = this.accounts.get(key.toBase58());
    return Promise.resolve(data ? { data } : null);
  }

  /** Samples `getRecentPrioritizationFees` answers with (ticket 10's
   *  operator priority fee). Empty by default, the same as an idle cluster. */
  prioritizationFees: { slot: number; prioritizationFee: number }[] = [];

  getRecentPrioritizationFees(
    config?: { lockedWritableAccounts?: PublicKey[] },
  ): Promise<{ slot: number; prioritizationFee: number }[]> {
    this.record("getRecentPrioritizationFees", config?.lockedWritableAccounts);
    return Promise.resolve(this.prioritizationFees);
  }

  /** Signatures `getSignaturesForAddress` answers with, newest first as the
   *  real RPC orders them. Empty by default, matching the old unconditional
   *  `[]` stub; a test drives the indexer's finalized catch-up path (ticket
   *  13) by populating this and `setTransaction` below. `getSignaturesForAddress`
   *  pages this array with `before`/`limit` the same way the real RPC pages a
   *  long backlog (ticket 06). */
  signaturesForAddress: { signature: string; slot: number; err: unknown; blockTime?: number }[] =
    [];
  private readonly transactions = new Map<string, FakeTransaction | undefined>();
  /** `getTransaction` for a signature configured here resolves after this
   *  many milliseconds instead of immediately, opening a window a test can
   *  fire a live event into (the race `catchUpEvents`'s single-enqueue fix
   *  closes, ticket 13). 0 by default: immediate, like every other fake here. */
  getTransactionDelayMs = 0;

  /** The finalized logs `getTransaction(signature)` answers with, and the
   *  transaction's account key list (empty unless a test needs it). */
  setTransaction(signature: string, logMessages: string[], keys: PublicKey[] = []): void {
    this.transactions.set(signature, {
      meta: { logMessages },
      transaction: { message: { getAccountKeys: () => ({ keySegments: () => [keys] }) } },
    });
  }

  getSignaturesForAddress(
    address: PublicKey,
    options?: { before?: string; until?: string; limit?: number },
  ): Promise<{ signature: string; slot: number; err: unknown; blockTime?: number }[]> {
    this.record("getSignaturesForAddress");
    this.watched = [...this.watched, address];
    // `before`: start just past that signature (older). `until`: stop just
    // before it (newer). Both default to the whole array, same as no option.
    const beforeIndex = options?.before
      ? this.signaturesForAddress.findIndex((info) => info.signature === options.before)
      : -1;
    const untilIndex = options?.until
      ? this.signaturesForAddress.findIndex((info) => info.signature === options.until)
      : -1;
    const start = beforeIndex === -1 ? 0 : beforeIndex + 1;
    const end = untilIndex === -1 ? this.signaturesForAddress.length : untilIndex;
    const page = this.signaturesForAddress.slice(start, end);
    return Promise.resolve(options?.limit ? page.slice(0, options.limit) : page);
  }

  getTransaction(signature: string): Promise<FakeTransaction | null> {
    this.record("getTransaction");
    const tx = this.transactions.get(signature) ?? null;
    if (this.getTransactionDelayMs <= 0) return Promise.resolve(tx);
    return new Promise((resolve) => setTimeout(() => resolve(tx), this.getTransactionDelayMs));
  }

  /** The plain call the sweep falls back to when the RPC has no V2. Always
   *  every account, in one page: that is the whole cost of the fallback. */
  getProgramAccounts(
    _programId: PublicKey,
    _config: { withContext: true },
  ): Promise<{ context: { slot: number }; value: { pubkey: PublicKey; account: { data: Buffer } }[] }> {
    this.record("getProgramAccounts");
    return Promise.resolve({
      context: { slot: this.slot },
      value: [...this.accounts.entries()].map(([pubkey, data]) => ({
        // SAFETY: keys go in through setAccount, which base58-encodes a real one.
        pubkey: new PublicKey(pubkey),
        account: { data },
      })),
    });
  }

  onLogs(
    address: PublicKey,
    callback: (logs: FakeLogs, context: { slot: number }) => void,
    commitment?: string,
  ): number {
    const id = this.record("onLogs");
    this.watched = [...this.watched, address];
    this.logsListeners.push({ address, commitment, callback });
    return id;
  }

  removeOnLogsListener(): Promise<void> {
    this.record("removeOnLogsListener");
    return Promise.resolve();
  }

  /** Test hook: simulates the RPC pushing a log notification to whichever
   *  `onLogs` registration matches `address` and `commitment` (the indexer
   *  subscribes on the same pool address twice, at different commitments). */
  fireLogs(address: PublicKey, commitment: string, logs: FakeLogs, slot: number): void {
    this.logsListeners
      .find((entry) => entry.address.equals(address) && entry.commitment === commitment)
      ?.callback(logs, { slot });
  }

  onAccountChange(
    address: PublicKey,
    callback: (info: { data: Buffer }) => void,
    _commitment?: string,
  ): number {
    const id = this.record("onAccountChange");
    this.accountChangeListeners.set(address.toBase58(), callback);
    return id;
  }

  removeAccountChangeListener(_id: number): Promise<void> {
    this.record("removeAccountChangeListener");
    return Promise.resolve();
  }

  /** Test hook: simulates the RPC pushing a notification that `address`'s
   *  data is now whatever `setAccount` last stored for it. */
  fireAccountChange(address: PublicKey): void {
    const data = this.accounts.get(address.toBase58());
    this.accountChangeListeners.get(address.toBase58())?.({ data: data ?? Buffer.alloc(0) });
  }

  getLatestBlockhash(
    _commitment?: string,
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    this.record("getLatestBlockhash");
    return Promise.resolve({
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: this.slot + 150,
    });
  }

  /** `simulateTransaction`'s `unitsConsumed`/error (production-hardening
   *  ticket 04's compute-limit simulation). Defaults to a clean simulation
   *  reporting 5,000 units, same order of magnitude as a real instruction. */
  simulateUnitsConsumed: number | undefined = 5_000;
  simulateError: unknown = undefined;

  simulateTransaction(): Promise<{
    value: { err: unknown; unitsConsumed?: number; logs: string[] | null };
  }> {
    this.record("simulateTransaction");
    if (this.simulateError) {
      return Promise.resolve({ value: { err: this.simulateError, logs: null } });
    }
    return Promise.resolve({
      value: {
        err: null,
        logs: [],
        ...(this.simulateUnitsConsumed === undefined
          ? {}
          : { unitsConsumed: this.simulateUnitsConsumed }),
      },
    });
  }

  /** `getPriorityFeeEstimate`'s answer (ticket 04's Helius estimate), served
   *  through `_rpcRequest` the same way the real Helius method arrives.
   *  Undefined (the default) makes `_rpcRequest` answer "unexpected RPC
   *  method", the same as a non-Helius endpoint, so `send` falls back to the
   *  p75 method below without a test having to opt in. */
  priorityFeeEstimateMicroLamports: number | undefined = undefined;

  /** `sendRawTransaction` calls, by 1-based count, that land no landing
   *  notification (simulates a dropped packet); every other call still
   *  notifies via `autoConfirmSignature`, same as today (ticket 04's
   *  rebroadcast loop). */
  dropSendsBeforeCall = 0;

  sendRawTransaction(rawTransaction: Buffer | Uint8Array | number[]): Promise<string> {
    // Params recorded (not just tallied) so a test can decode what was
    // actually sent, e.g. ticket 10's prepended compute-budget instruction.
    const count = this.record("sendRawTransaction", [rawTransaction]);
    if (this.autoConfirmSignature && count > this.dropSendsBeforeCall) {
      const listeners = this.signatureListeners;
      this.signatureListeners = [];
      queueMicrotask(() => {
        for (const listener of listeners) listener({ err: this.signatureError });
      });
    }
    return Promise.resolve("fake-signature");
  }

  /** See `autoConfirmSignature`. Records the signature, so a test can check
   *  the listener watched the one `send` returned. */
  onSignature(
    signature: string,
    callback: (result: { err: unknown }) => void,
    _commitment?: string,
  ): number {
    const id = this.record("onSignature", [signature]);
    this.signatureListeners = [...this.signatureListeners, callback];
    return id;
  }

  removeSignatureListener(_id: number): Promise<void> {
    this.record("removeSignatureListener");
    return Promise.resolve();
  }

  getSignatureStatuses(
    signatures: string[],
  ): Promise<{ value: ({ err: unknown } | null)[] }> {
    this.record("getSignatureStatuses");
    return Promise.resolve({ value: signatures.map(() => this.signatureStatus ?? null) });
  }

  getBlockHeight(_commitment?: string): Promise<number> {
    this.record("getBlockHeight");
    return Promise.resolve(this.blockHeight);
  }

  /**
   * Stands in for web3.js's own internal JSON-RPC transport, which the
   * indexer's `getProgramAccountsV2` walk reaches into because that method
   * has no typed `Connection` API (ticket 05, probed against the Free plan:
   * pages at 1,000, keyed by `paginationKey`, honours `changedSinceSlot`).
   * Paginates `accounts` by `pageSize` and honours `paginationKey`; it does
   * not filter by `changedSinceSlot` itself, a test drives that by choosing
   * what `accounts` holds (via `setAccount`/`clearAccounts`) for the call it
   * is asserting on.
   */
  _rpcRequest(
    method: string,
    params: unknown[],
  ): Promise<{ result?: unknown; error?: { code?: number; message: string } }> {
    const count = this.record(method, params);
    if (this.failOnCallNumber?.method === method && this.failOnCallNumber.number === count) {
      return Promise.reject(new Error(`CountingConnection: forced failure on ${method} call ${count}`));
    }
    if (method === "getPriorityFeeEstimate") {
      // Undefined answers "method not found", the same shape a non-Helius
      // endpoint returns, so `heliusPriorityFeeEstimate` falls back to
      // `getRecentPrioritizationFees` without a test having to opt in.
      if (this.priorityFeeEstimateMicroLamports === undefined) {
        return Promise.resolve({ error: { code: -32601, message: "Method not found" } });
      }
      return Promise.resolve({
        result: { priorityFeeEstimate: this.priorityFeeEstimateMicroLamports },
      });
    }
    if (method !== "getProgramAccountsV2") {
      return Promise.reject(new Error(`CountingConnection: unexpected RPC method ${method}`));
    }
    if (this.noProgramAccountsV2) {
      return Promise.resolve({ error: { code: -32601, message: "Method not found" } });
    }
    // SAFETY: the indexer always calls this with [programId, config].
    const [, config] = params as [
      string,
      { paginationKey?: string | null; filters?: { memcmp: { offset: number; bytes: string } }[] },
    ];
    // What the real RPC does with the null it just handed back: refuses it.
    // The last page ends the walk with `paginationKey: null` rather than
    // leaving the field out, so a walk that reads null as "one more page"
    // fails here instead of quietly looping (probed against devnet).
    if (config.paginationKey === null) {
      return Promise.resolve({
        error: { code: -32602, message: "Invalid param at index 1: invalid type: null, expected a string" },
      });
    }
    // Solami refuses a walk without one (probed 2026-10-11), so the fake does too.
    if (!config.filters?.length) {
      return Promise.resolve({ error: { code: -32602, message: `${method} requires at least one filter` } });
    }
    const entries = [...this.accounts.entries()].filter(([, data]) =>
      config.filters?.every(({ memcmp }) => {
        const bytes = Buffer.from(bs58.decode(memcmp.bytes));
        return data.subarray(memcmp.offset, memcmp.offset + bytes.length).equals(bytes);
      }),
    );
    const offset = config.paginationKey ? Number(config.paginationKey) : 0;
    const page = entries.slice(offset, offset + this.pageSize);
    const nextOffset = offset + this.pageSize;
    const paginationKey = nextOffset < entries.length ? String(nextOffset) : null;
    return Promise.resolve({
      result: {
        context: { slot: this.slot },
        value: {
          accounts: page.map(([pubkey, data]) => ({
            pubkey,
            account: { data: [data.toString("base64"), "base64"] },
          })),
          count: page.length,
          paginationKey,
        },
      },
    });
  }
}
