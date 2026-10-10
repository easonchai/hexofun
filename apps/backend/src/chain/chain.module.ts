import { Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";

import type { HexVaultEnv } from "../config/env";
import { BEAM_SENDER, BeamSender, loadQuic, MIN_TIP_LAMPORTS, QuicBeamTransport } from "./beam";
import { ChainService, SOLANA_CONNECTION } from "./chain.service";
import { withRpcFallback } from "./rpc-fallback";

/** The `RPC_URL` connection, with its subscriptions on `RPC_WS_URL` when set
 *  (solami 06). Unset, web3.js derives the socket from the HTTP URL. */
export function primaryConnection(rpcUrl: string, wsUrl: string | undefined): Connection {
  return new Connection(rpcUrl, wsUrl ? { commitment: "confirmed", wsEndpoint: wsUrl } : "confirmed");
}

@Module({
  providers: [
    {
      provide: SOLANA_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService<HexVaultEnv, true>) => {
        const primary = primaryConnection(
          config.get("RPC_URL", { infer: true }),
          config.get("RPC_WS_URL", { infer: true }),
        );
        const fallbackUrl = config.get("RPC_FALLBACK_URL", { infer: true });
        const fallback = fallbackUrl ? new Connection(fallbackUrl, "confirmed") : undefined;
        return withRpcFallback(
          primary,
          fallback,
          config.get("RPC_TIMEOUT_MS", { infer: true }),
        );
      },
    },
    {
      // Solami ticket 08: null, and every send stays on the RPC, unless
      // BEAM_KEYPAIR is set.
      provide: BEAM_SENDER,
      inject: [ConfigService],
      useFactory: async (config: ConfigService<HexVaultEnv, true>): Promise<BeamSender | null> => {
        const secret = config.get("BEAM_KEYPAIR", { infer: true });
        if (!secret) return null;
        try {
          await loadQuic();
        } catch (cause) {
          // On a musl image the native module cannot load. Off beats paying
          // a tip on every send that then goes through the RPC anyway.
          new Logger(ChainModule.name).error(
            `BEAM_KEYPAIR is set but the QUIC module does not load here; Beam stays off: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
          return null;
        }
        const timeoutMs = config.get("RPC_TIMEOUT_MS", { infer: true });
        return new BeamSender(
          new QuicBeamTransport(bs58.decode(secret), timeoutMs),
          config.get("BEAM_TIP_LAMPORTS", { infer: true }) ?? MIN_TIP_LAMPORTS,
          timeoutMs,
        );
      },
    },
    ChainService,
  ],
  exports: [ChainService],
})
export class ChainModule {}
