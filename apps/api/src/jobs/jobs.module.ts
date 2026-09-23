import { Module } from '@nestjs/common';
import { RulesModule } from '../alarms/rules.repository.js';
import { DeadlinesController, JobsController } from './jobs.controller.js';
import { JobsRepository } from './jobs.repository.js';

@Module({
  imports: [RulesModule],
  controllers: [JobsController, DeadlinesController],
  providers: [JobsRepository],
  exports: [JobsRepository],
})
export class JobsModule {}
