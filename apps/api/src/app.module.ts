import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AlarmsModule } from './alarms/alarms.module.js';
import { ApiKeyGuard } from './auth/api-key.guard.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { DatabaseModule } from './db/database.module.js';
import { HealthController } from './health/health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule, JobsModule, AlarmsModule],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
      exports: [APP_CONFIG],
    };
  }
}
