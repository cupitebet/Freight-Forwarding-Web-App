import { Module } from '@nestjs/common';
import { WebhookNotifier } from '@ff/deadline-alarm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { ALARM_NOTIFIER, AlarmScheduler } from './alarm.scheduler.js';
import { AlarmsController } from './alarms.controller.js';
import { AlarmsRepository } from './alarms.repository.js';
import { LogNotifier } from './log-notifier.js';
import { PgSentAlarmStore } from './pg-sent-alarm.store.js';
import { RulesModule } from './rules.repository.js';

@Module({
  imports: [JobsModule, RulesModule],
  controllers: [AlarmsController],
  providers: [
    PgSentAlarmStore,
    AlarmsRepository,
    AlarmScheduler,
    {
      provide: ALARM_NOTIFIER,
      inject: [APP_CONFIG],
      // Tanpa ALARM_WEBHOOK_URL, alarm log-only: tetap lengkap di tabel deadline_alarm_sent
      // (baca lewat GET /alarms), hanya belum diteruskan ke kanal eksternal. Isi ALARM_WEBHOOK_URL
      // kapan pun ada kanal (n8n, Slack, WhatsApp Cloud API, dst.) yang siap menerimanya.
      useFactory: ({ alarm }: AppConfig) =>
        alarm.webhookUrl ? new WebhookNotifier(alarm.webhookUrl, { secret: alarm.webhookSecret }) : new LogNotifier(),
    },
  ],
  exports: [AlarmScheduler],
})
export class AlarmsModule {}
