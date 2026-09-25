import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { runAlarmTick, type Notifier } from '@ff/deadline-alarm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { PG_POOL } from '../db/database.module.js';
import { JobsRepository } from '../jobs/jobs.repository.js';
import { PgSentAlarmStore } from './pg-sent-alarm.store.js';
import { RulesRepository } from './rules.repository.js';

export const ALARM_NOTIFIER = Symbol('ALARM_NOTIFIER');
const TICK_LOCK_ID = 7_274_002;

export interface TickSummary {
  at: string;
  ran: boolean; // false = instance lain sedang menjalankan tick
  jobs: number;
  sent: number;
  failed: number;
  durationMs: number;
}

/**
 * Menjalankan pengecekan alarm tiap ALARM_TICK_SECONDS. Hanya satu instance yang bekerja per tick
 * (pg advisory lock); klaim per alarm di PgSentAlarmStore tetap menjadi pengaman kedua.
 */
@Injectable()
export class AlarmScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(AlarmScheduler.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<TickSummary>;
  lastTick?: TickSummary;
  lastError?: { at: string; message: string };

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ALARM_NOTIFIER) private readonly notifier: Notifier,
    private readonly jobs: JobsRepository,
    private readonly rules: RulesRepository,
    private readonly store: PgSentAlarmStore,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.alarm.enabled) {
      this.log.warn('ALARM_ENABLED=false — scheduler alarm tidak dijalankan');
      return;
    }
    const run = () => void this.tick().catch(() => undefined);
    this.timer = setInterval(run, this.config.alarm.tickSeconds * 1000);
    this.timer.unref();
    run();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** Satu putaran. Tick yang tumpang tindih di instance yang sama digabung. */
  tick(now?: Date): Promise<TickSummary> {
    this.running ??= this.doTick(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async doTick(now = new Date()): Promise<TickSummary> {
    const started = Date.now();
    const client = await this.pool.connect();
    try {
      const locked = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [TICK_LOCK_ID])).rows[0]?.ok;
      if (!locked) return this.record({ at: now.toISOString(), ran: false, jobs: 0, sent: 0, failed: 0, durationMs: Date.now() - started });
      try {
        const [shipments, rules] = await Promise.all([this.jobs.findActiveShipments(), this.rules.load()]);
        const result = await runAlarmTick({ shipments, rules, store: this.store, notifier: this.notifier, now });
        for (const f of result.failed) {
          this.log.error(`Gagal kirim alarm ${f.alarm.key}: ${(f.error as Error)?.message ?? f.error} (dicoba lagi tick berikutnya)`);
        }
        return this.record({
          at: now.toISOString(),
          ran: true,
          jobs: shipments.length,
          sent: result.sent.length,
          failed: result.failed.length,
          durationMs: Date.now() - started,
        });
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [TICK_LOCK_ID]);
      }
    } catch (e) {
      this.lastError = { at: new Date().toISOString(), message: (e as Error).message };
      this.log.error(`Tick alarm gagal: ${(e as Error).message}`);
      throw e;
    } finally {
      client.release();
    }
  }

  private record(s: TickSummary): TickSummary {
    this.lastTick = s;
    if (s.sent || s.failed) this.log.log(`Tick: ${s.jobs} job, ${s.sent} alarm terkirim, ${s.failed} gagal (${s.durationMs} ms)`);
    return s;
  }
}
