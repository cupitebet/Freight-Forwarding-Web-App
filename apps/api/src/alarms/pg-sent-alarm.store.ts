import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import type { Alarm, SentAlarmStore } from '@ff/deadline-alarm';
import { PG_POOL } from '../db/database.module.js';

/** Klaim atomik per alarm key: aman walau beberapa instance API berjalan bersamaan. */
@Injectable()
export class PgSentAlarmStore implements SentAlarmStore {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async claim(alarm: Alarm): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO deadline_alarm_sent (alarm_key, job_id, rule_code, kind, severity, escalate)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (alarm_key) DO NOTHING`,
      [alarm.key, alarm.deadline.shipmentId, alarm.deadline.ruleCode, alarm.kind, alarm.severity, alarm.escalate],
    );
    return r.rowCount === 1;
  }

  async release(alarm: Alarm): Promise<void> {
    await this.pool.query('DELETE FROM deadline_alarm_sent WHERE alarm_key = $1', [alarm.key]);
  }
}
