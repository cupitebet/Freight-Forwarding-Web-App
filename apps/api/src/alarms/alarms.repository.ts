import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../db/database.module.js';
import type { listAlarmsQuerySchema } from './alarms.schemas.js';
import { z } from 'zod';

export interface SentAlarmRow {
  alarmKey: string;
  jobId: string;
  jobReference: string;
  ruleCode: string;
  kind: string;
  severity: string;
  escalate: boolean;
  sentAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

type ListFilter = z.infer<typeof listAlarmsQuerySchema>;

/** Riwayat alarm yang benar-benar terkirim (status SENT) — lihat apps/api/migrations/00{2,3}. */
@Injectable()
export class AlarmsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async listSent(filter: Omit<ListFilter, 'owner'>): Promise<SentAlarmRow[]> {
    const where: string[] = [`a.status = 'SENT'`];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.kind?.length) push('a.kind = ANY(?)', filter.kind);
    if (filter.severity?.length) push('a.severity = ANY(?)', filter.severity);
    if (filter.jobId) push('a.job_id = ?', filter.jobId);
    if (filter.acknowledged !== undefined) where.push(`a.acknowledged_at IS ${filter.acknowledged ? 'NOT NULL' : 'NULL'}`);
    params.push(filter.limit);

    const r = await this.pool.query<{
      alarm_key: string; job_id: string; job_reference: string; rule_code: string; kind: string; severity: string;
      escalate: boolean; sent_at: Date; acknowledged_by: string | null; acknowledged_at: Date | null;
    }>(
      `SELECT a.alarm_key, a.job_id, j.reference AS job_reference, a.rule_code, a.kind, a.severity,
              a.escalate, a.sent_at, a.acknowledged_by, a.acknowledged_at
       FROM deadline_alarm_sent a JOIN job j ON j.id = a.job_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.sent_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((row) => ({
      alarmKey: row.alarm_key,
      jobId: row.job_id,
      jobReference: row.job_reference,
      ruleCode: row.rule_code,
      kind: row.kind,
      severity: row.severity,
      escalate: row.escalate,
      sentAt: row.sent_at.toISOString(),
      acknowledgedBy: row.acknowledged_by,
      acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    }));
  }

  /** Idempoten: acknowledge ulang oleh orang lain tidak menimpa acknowledge pertama. */
  async acknowledge(alarmKey: string, by: string): Promise<SentAlarmRow> {
    const r = await this.pool.query(
      `UPDATE deadline_alarm_sent a SET acknowledged_by = COALESCE(a.acknowledged_by, $2), acknowledged_at = COALESCE(a.acknowledged_at, now())
       FROM job j
       WHERE a.alarm_key = $1 AND a.status = 'SENT' AND j.id = a.job_id
       RETURNING a.alarm_key, a.job_id, j.reference AS job_reference, a.rule_code, a.kind, a.severity,
                 a.escalate, a.sent_at, a.acknowledged_by, a.acknowledged_at`,
      [alarmKey, by],
    );
    if (!r.rowCount) throw new NotFoundException('Alarm tidak ditemukan');
    const row = r.rows[0];
    return {
      alarmKey: row.alarm_key,
      jobId: row.job_id,
      jobReference: row.job_reference,
      ruleCode: row.rule_code,
      kind: row.kind,
      severity: row.severity,
      escalate: row.escalate,
      sentAt: row.sent_at.toISOString(),
      acknowledgedBy: row.acknowledged_by,
      acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    };
  }
}
