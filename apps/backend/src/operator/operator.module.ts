import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";

import { ChainModule } from "../chain/chain.module";
import { OperatorService } from "./operator.service";

/**
 * `ScheduleModule.forRoot()` is imported here rather than in AppModule so the
 * crank brings its own scheduler. The indexer runs on a plain setInterval, so
 * this is the only `forRoot()` in the graph and no job double-fires.
 */
@Module({
  imports: [ScheduleModule.forRoot(), ChainModule],
  providers: [OperatorService],
  exports: [OperatorService],
})
export class OperatorModule {}
