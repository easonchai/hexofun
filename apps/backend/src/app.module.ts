import { Module } from "@nestjs/common";

import { ApiModule } from "./api/api.module";
import { WebhooksController } from "./api/webhooks.controller";
import { ChainModule } from "./chain/chain.module";
import { ConfigModule } from "./config/config.module";
import { HealthController } from "./health/health.controller";
import { IndexerModule } from "./indexer/indexer.module";
import { OperatorModule } from "./operator/operator.module";
import { PrismaModule } from "./prisma/prisma.module";

// PrismaModule is @Global(), but a global module still has to be imported
// once for Nest to instantiate it, and this is that once.
// WebhooksController sits here, not in ApiModule, because it writes through
// IndexerService and ApiModule does not import the Indexer.
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ChainModule,
    IndexerModule,
    OperatorModule,
    ApiModule,
  ],
  controllers: [HealthController, WebhooksController],
})
export class AppModule {}
