import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { ConfigService } from "@nestjs/config";
import helmet from "@fastify/helmet";

import { AppModule } from "./app.module";
import { runBootGuards } from "./boot-guard";
import { ChainService } from "./chain/chain.service";
import type { HexVaultEnv } from "./config/env";
import { PrismaService } from "./prisma/prisma.service";

async function bootstrap(): Promise<void> {
  // trustProxy: the API sits behind Traefik, so every request's remote
  // address is Traefik's; trusting the forwarded header is what lets the
  // throttler (api.module.ts) key on the real client (ticket 13).
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );
  // SAFETY: the workspace has two copies of `fastify` at different patch
  // versions (@nestjs/platform-fastify's own dependency vs. the root
  // devDependency @fastify/helmet's bundled types resolve against), so
  // TypeScript sees two structurally different `FastifyInstance` types for
  // what is, at runtime, the same fastify 5.x plugin API.
  await app.register(helmet as unknown as Parameters<typeof app.register>[0]);
  const config = app.get<ConfigService<HexVaultEnv, true>>(ConfigService);

  // ticket 10: refuses to start against the wrong network, Pool or mint,
  // and refuses a database mirroring another program's pools (retired pools
  // on this program are fine, ADR 0016).
  const chain = app.get(ChainService);
  const prisma = app.get(PrismaService);
  await runBootGuards({
    connection: chain.connection,
    program: chain.program,
    programId: chain.programId,
    poolAddress: chain.poolAddress(),
    acceptedMint: config.get("ACCEPTED_MINT", { infer: true }),
    cluster: config.get("CLUSTER", { infer: true }),
    env: process.env,
    mirroredPoolRows: () => prisma.pool.findMany({ select: { address: true, poolId: true } }),
  });

  // Comma-separated list, e.g. "https://app.vercel.app,http://localhost:5173".
  app.enableCors({
    origin: config
      .get("CORS_ORIGIN", { infer: true })
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  // ticket 10: onModuleDestroy hooks (OperatorService awaits its in-flight
  // tick) only run on SIGTERM/SIGINT when this is enabled.
  app.enableShutdownHooks();
  const port = Number(config.get("PORT", { infer: true }));
  await app.listen(port, "0.0.0.0");
}

bootstrap();
