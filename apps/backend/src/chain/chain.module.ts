import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Connection } from "@solana/web3.js";

import type { HexVaultEnv } from "../config/env";
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
    ChainService,
  ],
  exports: [ChainService],
})
export class ChainModule {}
