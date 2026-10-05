// vitest setupFiles run before a test file's own imports, which matters here:
// importing ConfigModule evaluates `NestConfigModule.forRoot({ validate })`
// immediately (it's inside the `@Module()` decorator argument), so these env
// vars have to exist before any test file imports config.module.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Integration tests talk to a real Postgres. Point DATABASE_URL at your own
// if this default is not it; `docker run -p 5433:5432 postgres:16-alpine`
// with these credentials is what the suites were written against.
process.env.DATABASE_URL ??=
  "postgresql://hexvault:hexvault@127.0.0.1:5433/hexvault";
process.env.RPC_URL ??= "http://127.0.0.1:8899";
process.env.OPERATOR_KEYPAIR ??= bs58.encode(Keypair.generate().secretKey);
process.env.ACCEPTED_MINT ??= Keypair.generate().publicKey.toBase58();
process.env.CORS_ORIGIN ??= "http://localhost:5173";
// PROGRAM_ID and CLUSTER have no default in validateEnv any more (ticket 10);
// these just satisfy that requirement for every suite that imports the real
// ConfigModule. None of them run boot-guard.ts's genesis-hash check. Plain `=`
// on purpose: suites assert against these exact values, so a PROGRAM_ID or
// POOL_ID exported in the developer's shell must not leak in.
process.env.POOL_ID = "1";
process.env.PROGRAM_ID = "LFk9ba6QXuM9oYRRNGGPxMGzfo13X3DAr8ghSPz72C6";
process.env.CLUSTER = "devnet";
// Same reason: a devnet .env sourced into the shell sets these to 0 and 300,
// which breaks the faucet 429 and referral "holding" assertions.
process.env.FAUCET_INTERVAL_SECONDS = "3600";
process.env.REFERRAL_QUALIFY_SECONDS = "604800";
// Beta-launch-fixes ticket 05: a harmless default so any suite that flips a
// seeded Pool's currentEpochId to 0 sees `/state`/`/status` carry a launch
// time, without every other suite (whose Pool already has an Epoch) noticing.
process.env.LAUNCH_AT ??= "2026-12-25T00:00:00.000Z";
