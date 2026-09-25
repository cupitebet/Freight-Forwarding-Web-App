import { z } from 'zod';
import type { AlarmKind, Severity } from '@ff/deadline-alarm';
import { OWNERS } from '../jobs/jobs.schemas.js';

// Record<Union, true> memaksa daftar runtime selalu sinkron dengan tipe di @ff/deadline-alarm.
const keys = <T extends string>(m: Record<T, true>) => Object.keys(m) as [T, ...T[]];

export const ALARM_KINDS = keys<AlarmKind>({ REMINDER: true, OVERDUE: true, MISSING_DATA: true });
export const SEVERITIES = keys<Severity>({ INFO: true, WARNING: true, CRITICAL: true });

const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',') : undefined))
    .pipe(z.array(z.enum(values)).optional());

/** Riwayat alarm yang sudah terkirim (GET /alarms). Default: hanya yang belum di-acknowledge. */
export const listAlarmsQuerySchema = z.object({
  owner: z.enum(OWNERS).optional(),
  kind: csv(ALARM_KINDS),
  severity: csv(SEVERITIES),
  jobId: z.uuid().optional(),
  acknowledged: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
