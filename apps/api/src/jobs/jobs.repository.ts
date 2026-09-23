import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { applyDcsaEvents, type DcsaChange, type DcsaEvent, type MilestoneEvent, type Shipment } from '@ff/deadline-alarm';
import { PG_POOL, withTransaction } from '../db/database.module.js';
import type { CreateJobInput, MilestoneInput, UpdateJobInput } from './jobs.schemas.js';

const MASTER_DOC_COLUMNS = {
  number: 'number',
  carrierCode: 'carrier_code',
  vesselName: 'vessel_name',
  voyage: 'voyage',
  portOfLoading: 'port_of_loading',
  portOfDischarge: 'port_of_discharge',
  etd: 'etd',
  atd: 'atd',
  eta: 'eta',
  ata: 'ata',
} as const;

const FREE_TIME_COLUMNS = {
  demurrageDays: 'demurrage_free_days',
  detentionDays: 'detention_free_days',
  storageDays: 'storage_free_days',
} as const;

/** Satu query untuk membentuk objek Shipment (tanpa N+1). */
const SHIPMENT_SELECT = `
  SELECT j.id, j.reference, j.direction, j.mode, j.roles, j.status, j.port_utc_offset_minutes,
         j.demurrage_free_days, j.detention_free_days, j.storage_free_days,
         m.vessel_name, m.voyage, m.port_of_loading, m.port_of_discharge, m.etd, m.atd, m.eta, m.ata,
         (SELECT coalesce(array_agg(c.number ORDER BY c.number), '{}') FROM container c WHERE c.job_id = j.id) AS containers,
         (SELECT coalesce(jsonb_object_agg(k.kind, k.at), '{}') FROM carrier_cutoff k WHERE k.job_id = j.id) AS cutoffs,
         (SELECT coalesce(jsonb_object_agg(e.event, e.occurred_at), '{}') FROM milestone e WHERE e.job_id = j.id) AS events,
         (SELECT coalesce(jsonb_object_agg(p.owner, p.contact), '{}') FROM job_pic p WHERE p.job_id = j.id) AS pic
  FROM job j
  LEFT JOIN master_doc m ON m.job_id = j.id`;

interface ShipmentRow {
  id: string;
  reference: string;
  direction: Shipment['direction'];
  mode: Shipment['mode'];
  roles: Shipment['roles'];
  status: 'ACTIVE' | 'CLOSED';
  port_utc_offset_minutes: number;
  demurrage_free_days: number | null;
  detention_free_days: number | null;
  storage_free_days: number | null;
  vessel_name: string | null;
  voyage: string | null;
  port_of_loading: string | null;
  port_of_discharge: string | null;
  etd: Date | null;
  atd: Date | null;
  eta: Date | null;
  ata: Date | null;
  containers: string[];
  cutoffs: Record<string, string>;
  events: Record<string, string>;
  pic: Record<string, string>;
}

export interface JobRecord {
  status: 'ACTIVE' | 'CLOSED';
  shipment: Shipment;
}

const iso = (d: Date | string | null | undefined) => (d == null ? undefined : new Date(d).toISOString());
const isoMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, iso(v)!]));
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function toShipment(r: ShipmentRow): Shipment {
  const freeTime = defined({
    demurrageDays: r.demurrage_free_days ?? undefined,
    detentionDays: r.detention_free_days ?? undefined,
    storageDays: r.storage_free_days ?? undefined,
  });
  return defined({
    id: r.id,
    reference: r.reference,
    direction: r.direction,
    mode: r.mode,
    roles: r.roles,
    portUtcOffsetMinutes: r.port_utc_offset_minutes,
    vesselName: r.vessel_name ?? undefined,
    voyage: r.voyage ?? undefined,
    portOfLoading: r.port_of_loading ?? undefined,
    portOfDischarge: r.port_of_discharge ?? undefined,
    containers: r.containers,
    etd: iso(r.etd),
    atd: iso(r.atd),
    eta: iso(r.eta),
    ata: iso(r.ata),
    freeTime,
    carrierCutoffs: isoMap(r.cutoffs),
    events: isoMap(r.events),
    pic: r.pic,
  });
}

/** Hash dedup event tracking; waktu dinormalkan ke UTC supaya "+07:00" dan "Z" yang sama tidak dobel. */
function eventHash(e: DcsaEvent): string {
  const common = [e.eventType, e.eventClassifierCode, e.location.UNLocationCode, new Date(e.eventDateTime).toISOString()];
  const specific =
    e.eventType === 'TRANSPORT'
      ? [e.transportEventTypeCode]
      : [e.equipmentEventTypeCode, e.equipmentReference, e.emptyIndicatorCode];
  return createHash('sha256').update([...common, ...specific].join('|')).digest('hex');
}

@Injectable()
export class JobsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async create(input: CreateJobInput, actor: string): Promise<string> {
    return withTransaction(this.pool, async (db) => {
      let id: string;
      try {
        const res = await db.query<{ id: string }>(
          `INSERT INTO job (reference, direction, mode, roles, port_utc_offset_minutes,
                            demurrage_free_days, detention_free_days, storage_free_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            input.reference, input.direction, input.mode, input.roles, input.portUtcOffsetMinutes,
            input.freeTime.demurrageDays ?? null, input.freeTime.detentionDays ?? null, input.freeTime.storageDays ?? null,
          ],
        );
        id = res.rows[0]!.id;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException(`Nomor job ${input.reference} sudah ada`);
        throw e;
      }

      const m = input.masterDoc;
      await db.query(
        `INSERT INTO master_doc (job_id, doc_type, number, carrier_code, vessel_name, voyage,
                                 port_of_loading, port_of_discharge, etd, atd, eta, ata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id, m.docType ?? (input.mode === 'SEA' ? 'MBL' : 'MAWB'), m.number ?? null, m.carrierCode ?? null,
          m.vesselName ?? null, m.voyage ?? null, m.portOfLoading ?? null, m.portOfDischarge ?? null,
          m.etd ?? null, m.atd ?? null, m.eta ?? null, m.ata ?? null,
        ],
      );
      for (const h of input.houseDocs) {
        await db.query(
          `INSERT INTO house_doc (job_id, doc_type, number, shipper, consignee, notify_party) VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, input.mode === 'SEA' ? 'HBL' : 'HAWB', h.number, h.shipper ?? null, h.consignee ?? null, h.notifyParty ?? null],
        );
      }
      for (const c of input.containers) {
        await db.query(
          `INSERT INTO container (job_id, number, size_type, seal_number, vgm_kg) VALUES ($1, $2, $3, $4, $5)`,
          [id, c.number, c.sizeType ?? null, c.sealNumber ?? null, c.vgmKg ?? null],
        );
      }
      await this.upsertCutoffs(db, id, input.carrierCutoffs);
      await this.upsertPic(db, id, input.pic);
      await this.audit(db, id, 'JOB_CREATED', { reference: input.reference }, actor);
      return id;
    });
  }

  async update(id: string, input: UpdateJobInput, actor: string): Promise<void> {
    await withTransaction(this.pool, async (db) => {
      await this.lockJob(db, id);
      if (input.masterDoc) await this.updateColumns(db, 'master_doc', MASTER_DOC_COLUMNS, input.masterDoc, id);
      if (input.freeTime) await this.updateColumns(db, 'job', FREE_TIME_COLUMNS, input.freeTime, id, 'id');
      if (input.carrierCutoffs) await this.upsertCutoffs(db, id, input.carrierCutoffs);
      if (input.pic) await this.upsertPic(db, id, input.pic);
      await db.query('UPDATE job SET updated_at = now() WHERE id = $1', [id]);
      await this.audit(db, id, 'JOB_UPDATED', input, actor);
    });
  }

  async close(id: string, actor: string): Promise<void> {
    const res = await this.pool.query(`UPDATE job SET status = 'CLOSED', updated_at = now() WHERE id = $1`, [id]);
    if (!res.rowCount) throw new NotFoundException('Job tidak ditemukan');
    await this.audit(this.pool, id, 'JOB_CLOSED', {}, actor);
  }

  /** Catat / koreksi milestone. Mengembalikan nilai sebelumnya jika ada. */
  async setMilestone(id: string, m: MilestoneInput, actor: string): Promise<{ previous?: string }> {
    return withTransaction(this.pool, async (db) => {
      await this.lockJob(db, id);
      const prev = await db.query<{ occurred_at: Date }>('SELECT occurred_at FROM milestone WHERE job_id = $1 AND event = $2', [id, m.event]);
      await db.query(
        `INSERT INTO milestone (job_id, event, occurred_at, source) VALUES ($1, $2, $3, $4)
         ON CONFLICT (job_id, event) DO UPDATE SET occurred_at = EXCLUDED.occurred_at, source = EXCLUDED.source, recorded_at = now()`,
        [id, m.event, m.occurredAt, m.source],
      );
      const previous = iso(prev.rows[0]?.occurred_at);
      await this.audit(db, id, previous ? 'MILESTONE_CORRECTED' : 'MILESTONE_SET', { ...m, previous }, actor);
      return { previous };
    });
  }

  async deleteMilestone(id: string, event: MilestoneEvent, actor: string): Promise<void> {
    const res = await this.pool.query('DELETE FROM milestone WHERE job_id = $1 AND event = $2 RETURNING occurred_at', [id, event]);
    if (!res.rowCount) throw new NotFoundException('Milestone tidak ditemukan');
    await this.audit(this.pool, id, 'MILESTONE_DELETED', { event, previous: iso(res.rows[0].occurred_at) }, actor);
  }

  /**
   * Simpan event tracking DCSA (dedup), lalu hitung ulang dari SELURUH riwayat job ini
   * sehingga aman untuk webhook incremental maupun polling riwayat penuh.
   */
  async ingestTracking(id: string, events: DcsaEvent[], actor: string): Promise<{ stored: number; changes: DcsaChange[] }> {
    return withTransaction(this.pool, async (db) => {
      await this.lockJob(db, id);
      let stored = 0;
      for (const e of events) {
        // Event yang dikirim ulang ikut diperbarui waktu terimanya: estimasi yang diulang
        // provider tetap dianggap estimasi terbaru.
        const r = await db.query<{ inserted: boolean }>(
          `INSERT INTO tracking_event (job_id, event_hash, payload) VALUES ($1, $2, $3)
           ON CONFLICT (job_id, event_hash) DO UPDATE SET received_at = clock_timestamp()
           RETURNING (xmax = 0) AS inserted`,
          [id, eventHash(e), e],
        );
        if (r.rows[0]?.inserted) stored++;
      }
      const history = (
        await db.query<{ payload: DcsaEvent }>('SELECT payload FROM tracking_event WHERE job_id = $1 ORDER BY received_at, id', [id])
      ).rows.map((r) => r.payload);
      const shipment = await this.loadShipment(db, id);
      const { changes } = applyDcsaEvents(shipment, history);

      for (const c of changes) {
        if (c.field.startsWith('events.')) {
          await db.query(
            `INSERT INTO milestone (job_id, event, occurred_at, source) VALUES ($1, $2, $3, 'DCSA') ON CONFLICT DO NOTHING`,
            [id, c.field.slice('events.'.length), c.value],
          );
        } else if (c.field in MASTER_DOC_COLUMNS) {
          const col = MASTER_DOC_COLUMNS[c.field as keyof typeof MASTER_DOC_COLUMNS];
          await db.query(`UPDATE master_doc SET ${col} = $2 WHERE job_id = $1`, [id, c.value]);
        }
      }
      if (changes.length) await this.audit(db, id, 'TRACKING_APPLIED', { stored, changes }, actor);
      return { stored, changes };
    });
  }

  async find(id: string): Promise<JobRecord | null> {
    const r = await this.pool.query<ShipmentRow>(`${SHIPMENT_SELECT} WHERE j.id = $1`, [id]);
    return r.rows[0] ? { status: r.rows[0].status, shipment: toShipment(r.rows[0]) } : null;
  }

  async get(id: string): Promise<JobRecord> {
    const job = await this.find(id);
    if (!job) throw new NotFoundException('Job tidak ditemukan');
    return job;
  }

  async findActiveShipments(): Promise<Shipment[]> {
    const r = await this.pool.query<ShipmentRow>(`${SHIPMENT_SELECT} WHERE j.status = 'ACTIVE' ORDER BY j.created_at`);
    return r.rows.map(toShipment);
  }

  // ------------------------------------------------------------------ helpers

  private async loadShipment(db: pg.PoolClient, id: string): Promise<Shipment> {
    const r = await db.query<ShipmentRow>(`${SHIPMENT_SELECT} WHERE j.id = $1`, [id]);
    return toShipment(r.rows[0]!);
  }

  /** Serialisasi perubahan per job (mis. dua webhook tracking bersamaan) + 404 bila tidak ada. */
  private async lockJob(db: pg.PoolClient, id: string): Promise<void> {
    const r = await db.query('SELECT 1 FROM job WHERE id = $1 FOR UPDATE', [id]);
    if (!r.rowCount) throw new NotFoundException('Job tidak ditemukan');
  }

  private async updateColumns(
    db: pg.PoolClient,
    table: 'master_doc' | 'job',
    columns: Record<string, string>,
    values: Record<string, unknown>,
    id: string,
    idColumn = 'job_id',
  ): Promise<void> {
    const entries = Object.entries(values).filter(([k, v]) => v !== undefined && k in columns);
    if (!entries.length) return;
    // Nama kolom hanya dari whitelist `columns`, nilai selalu lewat parameter.
    const sets = entries.map(([k], i) => `${columns[k]} = $${i + 2}`).join(', ');
    await db.query(`UPDATE ${table} SET ${sets} WHERE ${idColumn} = $1`, [id, ...entries.map(([, v]) => v)]);
  }

  private async upsertCutoffs(db: pg.PoolClient, id: string, cutoffs: Partial<Record<string, string | null>>): Promise<void> {
    for (const [kind, at] of Object.entries(cutoffs)) {
      if (at === undefined) continue;
      if (at === null) await db.query('DELETE FROM carrier_cutoff WHERE job_id = $1 AND kind = $2', [id, kind]);
      else
        await db.query(
          `INSERT INTO carrier_cutoff (job_id, kind, at) VALUES ($1, $2, $3)
           ON CONFLICT (job_id, kind) DO UPDATE SET at = EXCLUDED.at, updated_at = now()`,
          [id, kind, at],
        );
    }
  }

  private async upsertPic(db: pg.PoolClient, id: string, pic: Partial<Record<string, string | null>>): Promise<void> {
    for (const [owner, contact] of Object.entries(pic)) {
      if (contact === undefined) continue;
      if (contact === null) await db.query('DELETE FROM job_pic WHERE job_id = $1 AND owner = $2', [id, owner]);
      else
        await db.query(
          `INSERT INTO job_pic (job_id, owner, contact) VALUES ($1, $2, $3)
           ON CONFLICT (job_id, owner) DO UPDATE SET contact = EXCLUDED.contact`,
          [id, owner, contact],
        );
    }
  }

  private async audit(db: pg.Pool | pg.PoolClient, jobId: string, action: string, detail: unknown, actor: string): Promise<void> {
    await db.query('INSERT INTO audit_log (job_id, action, detail, actor) VALUES ($1, $2, $3, $4)', [jobId, action, JSON.stringify(detail), actor]);
  }
}
