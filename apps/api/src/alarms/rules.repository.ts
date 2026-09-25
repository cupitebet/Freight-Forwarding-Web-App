import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import pg from 'pg';
import { z } from 'zod';
import { DEFAULT_RULES, type DeadlineRule } from '@ff/deadline-alarm';
import { PG_POOL } from '../db/database.module.js';
import { CUTOFFS, MILESTONE_EVENTS, OWNERS, ROLES } from '../jobs/jobs.schemas.js';

const hours = z.number().finite();
const anchor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CARRIER_CUTOFF'), cutoff: z.enum(CUTOFFS) }),
  z.object({ kind: z.literal('DEPARTURE'), offsetHours: hours }),
  z.object({ kind: z.literal('ARRIVAL'), offsetHours: hours }),
  z.object({
    kind: z.literal('ARRIVAL_BY_VOYAGE'),
    thresholdHours: z.number().positive(),
    longVoyageOffsetHours: hours,
    shortVoyageOffsetHours: hours,
  }),
  z.object({ kind: z.literal('EVENT'), event: z.enum(MILESTONE_EVENTS), offsetHours: hours }),
  z.object({
    kind: z.literal('FREE_TIME'),
    from: z.union([z.enum(MILESTONE_EVENTS), z.literal('ARRIVAL')]),
    days: z.enum(['demurrageDays', 'detentionDays', 'storageDays']),
  }),
]);

const ruleSchema = z.object({
  code: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(['PELAYARAN', 'BEA_CUKAI', 'TERMINAL', 'BIAYA']),
  owner: z.enum(OWNERS),
  directions: z.array(z.enum(['EXPORT', 'IMPORT'])).min(1),
  modes: z.array(z.enum(['SEA', 'AIR'])).min(1),
  roles: z.array(z.enum(ROLES)).optional(),
  anchor,
  fallback: anchor.optional(),
  doneWhen: z.enum(MILESTONE_EVENTS),
  remindBeforeHours: z.array(z.number().positive()).min(1),
  overdueRepeatHours: z.number().positive().optional(),
  maxOverdueAlarms: z.number().int().min(0).optional(),
  basis: z.string().min(1),
  risk: z.string().min(1).optional(),
}) satisfies z.ZodType<DeadlineRule>;

/**
 * Katalog rule efektif = DEFAULT_RULES yang di-override / ditambah baris aktif di tabel `deadline_rule`
 * (scope 'default'). `active = false` menonaktifkan rule default dengan kode yang sama.
 * Baris yang tidak valid di-log dan diabaikan (rule default tetap dipakai) supaya satu salah input
 * tidak mematikan seluruh alarm.
 */
@Injectable()
export class RulesRepository {
  private readonly log = new Logger(RulesRepository.name);

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async load(): Promise<DeadlineRule[]> {
    const rows = (
      await this.pool.query<{ code: string; definition: unknown; active: boolean }>(
        `SELECT code, definition, active FROM deadline_rule WHERE scope = 'default'`,
      )
    ).rows;
    const byCode = new Map(DEFAULT_RULES.map((r) => [r.code, r]));
    for (const row of rows) {
      if (!row.active) {
        byCode.delete(row.code);
        continue;
      }
      const parsed = ruleSchema.safeParse({ ...(row.definition as object), code: row.code });
      if (!parsed.success) {
        this.log.error(`deadline_rule ${row.code} tidak valid, diabaikan: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        continue;
      }
      byCode.set(row.code, parsed.data);
    }
    return [...byCode.values()];
  }
}

@Module({ providers: [RulesRepository], exports: [RulesRepository] })
export class RulesModule {}
