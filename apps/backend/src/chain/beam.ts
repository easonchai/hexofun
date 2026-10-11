// Solami ticket 08: operator transactions go to Solami's Beam sender first,
// with a tip transfer, and fall back to `sendRawTransaction` (ADR 0027).
//
// Transport: QUIC through `@matrixai/quic`, chosen 2026-10-10. The other
// option, gRPC `SwqosService/Submit` with an `x-token`, has no published
// proto or JavaScript client: github.com/useSolami/snippets and the `solami`
// npm SDK (0.1.56) both send over QUIC only, so gRPC cannot be built from
// what is public. `@matrixai/quic` is native. It ships prebuilds for
// linux-x64 (glibc), darwin and win32, and none for musl or linux-arm64. A
// loopback probe sent bytes through it on macOS and on node:22-bookworm-slim
// (amd64); on node:22-alpine it fails with ERR_DLOPEN_FAILED, with or
// without `gcompat`. The backend image is node:22-alpine today, so there
// ChainModule logs an error at boot and leaves Beam off until the image
// moves to a glibc base.
//
// The client certificate is built here from the swQoS keypair's first 32
// bytes (the reference client uses `@peculiar/x509` for this, one more
// dependency tree for one self-signed certificate).
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Logger } from "@nestjs/common";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

import { withTimeout } from "./rpc-fallback";

export const BEAM_HOST = "beam.solami.dev";
export const BEAM_PORT = 11_000;
export const BEAM_ALPN = "solana-tpu";
export const TIP_ADDRESSES_URL = "https://api.solami.dev/onchain/tip-addresses";
/** Beam refuses a smaller tip with `tip_too_low`. */
export const MIN_TIP_LAMPORTS = 100_000;
export const TIP_ADDRESSES_TTL_MS = 60 * 60 * 1000;
/** The reference client waits this long after closing the stream before
 *  tearing the connection down, so the last packet leaves. */
const FLUSH_DELAY_MS = 50;

/** Nest token for the `BeamSender`, or null when `BEAM_KEYPAIR` is unset. */
export const BEAM_SENDER = Symbol("BEAM_SENDER");

/** Hands signed transaction bytes to Beam. Tests swap in a fake. */
export interface BeamTransport {
  submit(raw: Uint8Array): Promise<void>;
}

/** `/status`'s `beam` field. `landed` counts Beam submits that confirmed,
 *  whichever copy (Beam's or an RPC rebroadcast) got there first. */
export interface BeamStatus {
  enabled: true;
  sent: number;
  landed: number;
}

/** Fetches the tip address list; the default is a plain GET. */
export type TipAddressFetcher = (signal: AbortSignal) => Promise<unknown>;

const fetchTipAddresses: TipAddressFetcher = async (signal) => {
  const response = await fetch(TIP_ADDRESSES_URL, { signal });
  if (!response.ok) throw new Error(`tip addresses answered ${response.status}`);
  return response.json();
};

export class BeamSender {
  private readonly logger = new Logger(BeamSender.name);
  private sent = 0;
  private landed = 0;
  private tips: { at: number; addresses: PublicKey[] } | undefined;

  constructor(
    private readonly transport: BeamTransport,
    private readonly tipLamports: number,
    private readonly timeoutMs: number,
    private readonly fetchTips: TipAddressFetcher = fetchTipAddresses,
  ) {}

  /**
   * A transfer of the tip from `payer` to one of Solami's tip addresses,
   * picked at random per call. The list is cached for an hour; a failed
   * refresh keeps the stale list, and with no list at all this throws.
   */
  async tipInstruction(payer: PublicKey): Promise<TransactionInstruction> {
    const addresses = await this.tipAddresses();
    // SAFETY: tipAddresses never returns an empty list.
    const tipAccount = addresses[Math.floor(Math.random() * addresses.length)] as PublicKey;
    return SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: tipAccount,
      lamports: this.tipLamports,
    });
  }

  /** Sends `raw` over the transport, bounded by `RPC_TIMEOUT_MS`. */
  async submit(raw: Uint8Array): Promise<void> {
    try {
      await withTimeout(this.transport.submit(raw), this.timeoutMs, "Beam submit");
    } catch (cause) {
      throw new Error("Beam submit failed", { cause });
    }
    this.sent += 1;
  }

  recordLanded(): void {
    this.landed += 1;
  }

  status(): BeamStatus {
    return { enabled: true, sent: this.sent, landed: this.landed };
  }

  private async tipAddresses(): Promise<PublicKey[]> {
    if (this.tips && Date.now() - this.tips.at <= TIP_ADDRESSES_TTL_MS) {
      return this.tips.addresses;
    }
    try {
      const addresses = parseTipAddresses(
        await this.fetchTips(AbortSignal.timeout(this.timeoutMs)),
      );
      this.tips = { at: Date.now(), addresses };
      return addresses;
    } catch (cause) {
      if (this.tips) {
        this.logger.warn(`tip address refresh failed, keeping the cached list: ${messageOf(cause)}`);
        return this.tips.addresses;
      }
      throw new Error("Beam tip addresses unavailable", { cause });
    }
  }
}

/** The tip endpoint's body: a non-empty array of base58 addresses. */
export function parseTipAddresses(body: unknown): PublicKey[] {
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error("tip addresses: expected a non-empty array");
  }
  return body.map((entry) => {
    if (typeof entry !== "string") throw new Error("tip addresses: expected strings");
    return new PublicKey(entry);
  });
}

/** The slice of `@matrixai/quic` this file calls. Its types sit behind
 *  `exports`, which this tsconfig's `moduleResolution: node` cannot read. */
export interface QuicModule {
  QUICClient: {
    createQUICClient(
      opts: {
        host: string;
        port: number;
        crypto: { ops: { randomBytes(data: ArrayBuffer): Promise<void> } };
        config: {
          key: string;
          cert: string;
          verifyPeer: boolean;
          applicationProtos: string[];
        };
        logger: QuicLogger;
      },
      ctx?: { timer?: number },
    ): Promise<QuicClient>;
  };
}

interface QuicClient {
  connection: { newStream(type: "uni"): { writable: WritableStream<Uint8Array> } };
  destroy(opts?: { force?: boolean }): Promise<void>;
}

/** The calls `@matrixai/quic` makes on its logger. */
interface QuicLogger {
  getChild(key: string): QuicLogger;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const quicNestLogger = new Logger("BeamQuic");
/** Its default logger prints every connection's lifecycle at INFO to the
 *  console; only warnings and errors reach the Nest log. */
const quicLogger: QuicLogger = {
  getChild: () => quicLogger,
  debug: () => {},
  info: () => {},
  warn: (message) => quicNestLogger.warn(message),
  error: (message) => quicNestLogger.error(message),
};

let quicModule: Promise<QuicModule> | undefined;

/**
 * `@matrixai/quic` is ESM-only and this backend compiles to CommonJS, where
 * TypeScript turns `import()` into `require()`, which the package's
 * `exports` refuses. A `Function`-built `import()` survives compilation, and
 * the absolute URL keeps resolution independent of the working directory.
 * Loaded only with Beam on (once at boot, by ChainModule), so Beam off never
 * touches the native module.
 */
export function loadQuic(): Promise<QuicModule> {
  if (!quicModule) {
    const dir = dirname(require.resolve("@matrixai/quic/package.json"));
    const importEsm = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;
    // SAFETY: QuicModule is the subset of the package's own typings this file uses.
    quicModule = importEsm(pathToFileURL(join(dir, "dist/index.js")).href) as Promise<QuicModule>;
    // A failed load is retried on the next submit rather than cached.
    quicModule.catch(() => {
      quicModule = undefined;
    });
  }
  return quicModule;
}

/**
 * One QUIC connection per submit: the operator sends a few transactions a
 * day, so a kept-alive connection would only add reconnect handling.
 */
export class QuicBeamTransport implements BeamTransport {
  private readonly tls: { key: string; cert: string };

  constructor(
    swqosSecretKey: Uint8Array,
    private readonly timeoutMs: number,
    private readonly endpoint: { host: string; port: number } = { host: BEAM_HOST, port: BEAM_PORT },
    /** Vitest runs modules in a context where the `Function` import fails,
     *  so its suite passes a plain `import()` here. */
    private readonly load: () => Promise<QuicModule> = loadQuic,
  ) {
    this.tls = clientCertificate(swqosSecretKey.slice(0, 32));
  }

  async submit(raw: Uint8Array): Promise<void> {
    const { QUICClient } = await this.load();
    const client = await QUICClient.createQUICClient(
      {
        ...this.endpoint,
        crypto: {
          ops: {
            async randomBytes(data) {
              new Uint8Array(data).set(randomBytes(data.byteLength));
            },
          },
        },
        config: { ...this.tls, verifyPeer: false, applicationProtos: [BEAM_ALPN] },
        logger: quicLogger,
      },
      { timer: this.timeoutMs },
    );
    try {
      const writer = client.connection.newStream("uni").writable.getWriter();
      await writer.write(raw);
      await writer.close();
      await new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS));
    } finally {
      await client.destroy();
    }
  }
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** DER tag-length-value, for lengths under 64 KiB. */
function der(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const ED25519_ALGORITHM = der(0x30, der(0x06, Buffer.from([0x2b, 0x65, 0x70])));
const CN_SOLANA_NODE = der(
  0x30,
  der(0x31, der(0x30, der(0x06, Buffer.from([0x55, 0x04, 0x03])), der(0x0c, Buffer.from("solana-node")))),
);
// Fixed dates, as Agave's own dummy TPU certificate uses: no clock involved.
const VALIDITY = der(0x30, der(0x17, Buffer.from("700101000000Z")), der(0x18, Buffer.from("40960101000000Z")));

/**
 * A self-signed Ed25519 X.509 v3 certificate for `seed`, the identity Beam
 * reads its stake-weighted priority from, plus the PEM private key.
 */
export function clientCertificate(seed: Uint8Array): { key: string; cert: string } {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    ED25519_ALGORITHM,
    CN_SOLANA_NODE,
    VALIDITY,
    CN_SOLANA_NODE,
    spki,
  );
  const signature = sign(null, tbs, privateKey);
  const cert = der(0x30, tbs, ED25519_ALGORITHM, der(0x03, Buffer.from([0]), signature));
  const base64 = cert.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
