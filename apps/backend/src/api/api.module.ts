import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

import { ChainModule } from "../chain/chain.module";
import { AccessController } from "./access.controller";
import { AlertsController } from "./alerts.controller";
import { ApiController } from "./api.controller";
import { ApiService } from "./api.service";
import { BetsController } from "./bets.controller";
import { ErrorReportController } from "./error-report.controller";
import { FastPauseController } from "./fast-pause.controller";
import { FaucetController } from "./faucet.controller";
import { GameConfigController } from "./game-config.controller";
import { GrantsController } from "./grants.controller";
import { OpsController } from "./ops.controller";
import { OpsSummaryService } from "./ops-summary";
import { ReferralsController } from "./referrals.controller";
import { RoundRecordController } from "./round-record.controller";
import { RoundsService } from "./rounds.service";
import { SerializationInterceptor } from "./serialization.interceptor";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";
import { SparringService } from "./sparring.service";

/**
 * spec.md §3.5. The interceptor and the guard are registered here rather than
 * in main.ts so importing this module is the whole wiring. `skipIf` keeps the
 * global guard off every route but the faucet, access and one referrals
 * route, plus the read routes (ApiController), which carry their own 60 a
 * minute limit per address and route, set on the class, enough for the web's
 * 2 s polling (audit-2026-10-09 09). /healthz is a container probe. Access is throttled too, same limit: a script trying
 * invite codes against POST /access/redeem is exactly what this guards
 * against (ticket 06). `POST /game/bets` is throttled per session and
 * address on its handler (off-chain-tickets 16). `POST /error-reports` is written to the shared
 * Postgres by anyone, so it is throttled too, tighter (5 a minute, set on the
 * handler; mainnet-readiness-fixes 10). `POST /referrals/apply` shares that limit for the
 * same reason (ticket 02); the rest of ReferralsController (the polled GET
 * /referrals/:wallet) stays unthrottled.
 */
@Module({
  imports: [
    ChainModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 10,
        skipIf: (context) => {
          const controller = context.getClass();
          if (
            controller === FaucetController ||
            controller === AccessController ||
            controller === ErrorReportController ||
            controller === FastPauseController ||
            controller === SessionsController ||
            controller === BetsController ||
            controller === ApiController
          ) {
            return false;
          }
          return !(
            controller === ReferralsController &&
            context.getHandler() === ReferralsController.prototype.applyReferral
          );
        },
      },
    ]),
  ],
  controllers: [
    ApiController,
    OpsController,
    AlertsController,
    FaucetController,
    AccessController,
    FastPauseController,
    ReferralsController,
    ErrorReportController,
    GameConfigController,
    GrantsController,
    SessionsController,
    BetsController,
    RoundRecordController,
  ],
  providers: [
    ApiService,
    SessionsService,
    RoundsService,
    SparringService,
    OpsSummaryService,
    { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class ApiModule {}
