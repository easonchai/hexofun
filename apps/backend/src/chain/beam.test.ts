// Solami ticket 08: the tip address cache, the client certificate, and the
// QUIC transport against a local server standing in for Beam.
import { createHmac, randomBytes, X509Certificate } from "node:crypto";

import { Keypair, PublicKey, SystemInstruction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BEAM_ALPN,
  BeamSender,
  clientCertificate,
  parseTipAddresses,
  QuicBeamTransport,
  TIP_ADDRESSES_TTL_MS,
} from "./beam";

const TIP = Keypair.generate().publicKey;
const PAYER = Keypair.generate().publicKey;
const noTransport = { submit: async () => {} };

describe("BeamSender.tipInstruction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("transfers the tip to a listed address, fetching the list once an hour", async () => {
    vi.useFakeTimers();
    const fetchTips = vi.fn(async () => [TIP.toBase58()]);
    const beam = new BeamSender(noTransport, 123_456, 1_000, fetchTips);

    const transfer = SystemInstruction.decodeTransfer(await beam.tipInstruction(PAYER));
    await beam.tipInstruction(PAYER);

    expect(transfer.fromPubkey.equals(PAYER)).toBe(true);
    expect(transfer.toPubkey.equals(TIP)).toBe(true);
    expect(transfer.lamports).toBe(123_456n);
    expect(fetchTips).toHaveBeenCalledTimes(1);

    // Past the hour, a failed refresh keeps the list it had.
    vi.advanceTimersByTime(TIP_ADDRESSES_TTL_MS + 1);
    fetchTips.mockRejectedValueOnce(new Error("503"));
    const stale = SystemInstruction.decodeTransfer(await beam.tipInstruction(PAYER));
    expect(stale.toPubkey.equals(TIP)).toBe(true);
    expect(fetchTips).toHaveBeenCalledTimes(2);
  });

  it("throws when no list was ever fetched", async () => {
    const beam = new BeamSender(noTransport, 100_000, 1_000, async () => {
      throw new Error("offline");
    });
    await expect(beam.tipInstruction(PAYER)).rejects.toThrow("Beam tip addresses unavailable");
  });

  it("refuses a body that is not a non-empty list of addresses", () => {
    for (const body of [{}, [], [42], ["not-a-key"]]) {
      expect(() => parseTipAddresses(body)).toThrow();
    }
    expect(parseTipAddresses([TIP.toBase58()])[0]?.equals(TIP)).toBe(true);
  });
});

describe("clientCertificate", () => {
  it("is a self-signed Ed25519 certificate for the swQoS key's public key", () => {
    const swqos = Keypair.generate();
    const { cert } = clientCertificate(swqos.secretKey.slice(0, 32));

    const parsed = new X509Certificate(cert);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.publicKey.asymmetricKeyType).toBe("ed25519");
    // The last 32 bytes of an Ed25519 SPKI are the raw key.
    const raw = parsed.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    expect(new PublicKey(raw).equals(swqos.publicKey)).toBe(true);
  });
});

describe("QuicBeamTransport", () => {
  it("delivers the bytes on a uni stream, presenting the swQoS certificate", async () => {
    // A variable specifier: this tsconfig cannot read the package's typings.
    const specifier = "@matrixai/quic";
    const { QUICServer, events } = await import(specifier);
    const swqos = Keypair.generate();
    let peerCert: Uint8Array | undefined;
    const server = new QUICServer({
      crypto: {
        key: randomBytes(32).buffer,
        ops: {
          sign: async (key: ArrayBuffer, data: ArrayBuffer) =>
            createHmac("sha256", Buffer.from(key)).update(Buffer.from(data)).digest().buffer,
          verify: async (key: ArrayBuffer, data: ArrayBuffer, sig: ArrayBuffer) =>
            createHmac("sha256", Buffer.from(key)).update(Buffer.from(data)).digest().equals(Buffer.from(sig)),
        },
      },
      config: {
        ...clientCertificate(randomBytes(32)),
        verifyPeer: true,
        verifyCallback: async (certs: Uint8Array[]) => {
          peerCert = certs[0];
          return undefined;
        },
        applicationProtos: [BEAM_ALPN],
      },
      logger: quietLogger(),
    });
    const received = new Promise<Buffer>((resolve) => {
      server.addEventListener(events.EventQUICServerConnection.name, (connection: CustomEvent) => {
        connection.detail.addEventListener(events.EventQUICConnectionStream.name, async (stream: CustomEvent) => {
          const chunks: Buffer[] = [];
          for await (const chunk of stream.detail.readable) chunks.push(Buffer.from(chunk));
          resolve(Buffer.concat(chunks));
        });
      });
    });
    await server.start({ host: "127.0.0.1", port: 0 });
    try {
      const transport = new QuicBeamTransport(
        swqos.secretKey,
        5_000,
        { host: "127.0.0.1", port: server.port },
        () => import(specifier),
      );
      const raw = randomBytes(300);

      await transport.submit(raw);

      expect((await received).equals(raw)).toBe(true);
      // SAFETY: the server's verifyCallback ran before the handshake finished.
      const presented = new X509Certificate(Buffer.from(peerCert as Uint8Array));
      const key = presented.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
      expect(new PublicKey(key).equals(swqos.publicKey)).toBe(true);
    } finally {
      await server.stop({ force: true });
    }
  });
});

/** The QUIC library logs every connection at INFO to the console. */
function quietLogger() {
  const logger = {
    getChild: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}
