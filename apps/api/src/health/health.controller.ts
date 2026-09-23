import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import { Public } from '../auth/api-key.guard.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { PG_POOL } from '../db/database.module.js';
import { AlarmScheduler } from '../alarms/alarm.scheduler.js';

/**
 * Untuk load balancer / uptime monitor. 503 jika database tidak bisa diakses atau
 * scheduler alarm macet (tick terakhir lebih lama dari 3x interval) — alarm yang diam-diam
 * berhenti adalah kegagalan paling berbahaya untuk modul ini.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly scheduler: AlarmScheduler,
  ) {}

  @Get()
  @Public()
  async check() {
    const problems: string[] = [];
    try {
      await this.pool.query('SELECT 1');
    } catch {
      problems.push('database tidak dapat diakses');
    }
    const { enabled, tickSeconds } = this.config.alarm;
    const last = this.scheduler.lastTick;
    if (enabled) {
      const age = last ? (Date.now() - Date.parse(last.at)) / 1000 : Infinity;
      if (age > tickSeconds * 3 && process.uptime() > tickSeconds * 3) problems.push('scheduler alarm tidak berjalan');
    }
    const body = { status: problems.length ? 'error' : 'ok', problems, alarm: { enabled, lastTick: last ?? null, lastError: this.scheduler.lastError ?? null } };
    if (problems.length) throw new ServiceUnavailableException(body);
    return body;
  }
}
