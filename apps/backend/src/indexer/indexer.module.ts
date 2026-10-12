import { Module } from "@nestjs/common";

import { ChainModule } from "../chain/chain.module";
import { IndexerService } from "./indexer.service";
import { MirageService } from "./mirage.service";
import { subgraphProvider } from "./subgraph";

// PrismaModule is @Global(), so PrismaService needs no import here.
@Module({
  imports: [ChainModule],
  providers: [IndexerService, subgraphProvider, MirageService],
  exports: [IndexerService, MirageService],
})
export class IndexerModule {}
