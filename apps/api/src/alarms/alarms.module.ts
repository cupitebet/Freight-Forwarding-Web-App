import { Logger, Module } from '@nestjs/common';
import { ConsoleNotifier, WebhookNotifier } from '@ff/deadline-alarm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { ALARM_NOTIFIER, AlarmScheduler } from './alarm.scheduler.js';
import { PgSentAlarmStore } from './pg-sent-alarm.store.js';
import { RulesModule } from './rules.repository.js';

@Module({
  imports: [JobsModule, RulesModule],
  providers: [
    PgSentAlarmStore,
    AlarmScheduler,
    {
      provide: ALARM_NOTIFIER,
      inject: [APP_CONFIG],
      useFactory: ({ alarm }: AppConfig) => {
        if (alarm.webhookUrl) return new WebhookNotifier(alarm.webhookUrl, { secret: alarm.webhookSecret });
        new Logger('AlarmsModule').warn('N8N_ALARM_WEBHOOK_URL kosong — alarm hanya ditulis ke log');
        return new ConsoleNotifier();
      },
    },
  ],
  exports: [AlarmScheduler],
})
export class AlarmsModule {}
