import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import type { Alarm, SentAlarmStore } from '@ff/deadline-alarm';
import { PG_POOL } from '../db/database.module.js';

/**
 * Lease klaim. Harus jauh lebih lama dari timeout webhook (10 detik) supaya pengiriman yang
 * masih berjalan tidak diambil alih, tapi cukup pendek agar alarm yang klaimnya tertinggal
 * (proses mati sebelum konfirmasi) terkirim ulang dalam beberapa tick.
 */
export const CLAIM_LEASE_SECONDS = 10 * 60;

/** Klaim atomik per alarm key: aman walau beberapa instance API berjalan bersamaan. */
@Injectable()
export class PgSentAlarmStore implements SentAlarmStore {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async claim(alarm: Alarm): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO deadline_alarm_sent (alarm_key, job_id, rule_code, kind, severity, escalate)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (alarm_key) DO UPDATE SET claimed_at = now()
         WHERE deadline_alarm_sent.status = 'PENDING'
           AND deadline_alarm_sent.claimed_at < now() - make_interval(secs => $7)`,
      [alarm.key, alarm.deadline.shipmentId, alarm.deadline.ruleCode, alarm.kind, alarm.severity, alarm.escalate, CLAIM_LEASE_SECONDS],
    );
    return r.rowCount === 1;
  }

  async confirm(alarm: Alarm): Promise<void> {
    await this.pool.query(`UPDATE deadline_alarm_sent SET status = 'SENT', sent_at = now() WHERE alarm_key = $1`, [alarm.key]);
  }

  async release(alarm: Alarm): Promise<void> {
    await this.pool.query(`DELETE FROM deadline_alarm_sent WHERE alarm_key = $1 AND status = 'PENDING'`, [alarm.key]);
  }
}
