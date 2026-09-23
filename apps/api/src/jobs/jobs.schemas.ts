import { z } from 'zod';
import type { CarrierCutoff, CompanyRole, MilestoneEvent, Owner } from '@ff/deadline-alarm';

// Record<Union, true> memaksa daftar runtime selalu sinkron dengan tipe di @ff/deadline-alarm.
const keys = <T extends string>(m: Record<T, true>) => Object.keys(m) as [T, ...T[]];

export const MILESTONE_EVENTS = keys<MilestoneEvent>({
  SI_SUBMITTED: true, VGM_SUBMITTED: true, DRAFT_BL_APPROVED: true, NPE_ISSUED: true, PEB_BL_UPDATED: true, CONTAINER_GATE_IN: true,
  OUTWARD_MANIFEST_SUBMITTED: true, RKSP_SUBMITTED: true, INWARD_MANIFEST_SUBMITTED: true, HOUSE_BL_RECONCILED: true, PIB_SUBMITTED: true,
  SPPB_ISSUED: true, RED_LANE_ASSIGNED: true, PHYSICAL_INSPECTION_DONE: true, CONTAINER_DISCHARGED: true,
  CONTAINER_GATE_OUT: true, EMPTY_RETURNED: true,
});
export const CUTOFFS = keys<CarrierCutoff>({ SI: true, VGM: true, CY: true, DRAFT_BL: true });
export const OWNERS = keys<Owner>({ DOCS: true, CUSTOMS: true, OPS: true, FINANCE: true });
export const ROLES = keys<CompanyRole>({ PPJK: true, NVOCC: true, CARRIER_AGENT: true });

/** ISO 8601 dengan offset eksplisit (mis. +07:00 atau Z) — tanpa offset ditolak supaya WIB/WITA/WIT tidak tertukar. */
const instant = z.iso.datetime({ offset: true });
const unlocode = z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}$/, 'UN/LOCODE 5 karakter, mis. IDJKT');
const text = z.string().trim().min(1).max(200);
const freeDays = z.number().int().min(0).max(365);

const freeTime = z.object({
  demurrageDays: freeDays.nullable().optional(),
  detentionDays: freeDays.nullable().optional(),
  storageDays: freeDays.nullable().optional(),
});

const schedule = {
  number: text.nullable().optional(),
  carrierCode: text.nullable().optional(),
  vesselName: text.nullable().optional(),
  voyage: text.nullable().optional(),
  portOfLoading: unlocode.nullable().optional(),
  portOfDischarge: unlocode.nullable().optional(),
  etd: instant.nullable().optional(),
  atd: instant.nullable().optional(),
  eta: instant.nullable().optional(),
  ata: instant.nullable().optional(),
};

export const createJobSchema = z.object({
  reference: z.string().trim().min(1).max(50),
  direction: z.enum(['EXPORT', 'IMPORT']),
  mode: z.enum(['SEA', 'AIR']),
  roles: z.array(z.enum(ROLES)).max(3).default([]),
  portUtcOffsetMinutes: z.union([z.literal(420), z.literal(480), z.literal(540)]).default(420),
  freeTime: freeTime.default({}),
  masterDoc: z.object({ docType: z.enum(['MBL', 'MAWB']).optional(), ...schedule }).default({}),
  houseDocs: z
    .array(z.object({ number: text, shipper: text.optional(), consignee: text.optional(), notifyParty: text.optional() }))
    .max(500)
    .default([]),
  containers: z
    .array(
      z.object({
        number: z.string().regex(/^[A-Z]{4}\d{7}$/, 'nomor container ISO 6346, mis. MSCU7349821'),
        sizeType: z.string().max(10).optional(),
        sealNumber: z.string().max(50).optional(),
        vgmKg: z.number().positive().optional(),
      }),
    )
    .max(500)
    .default([]),
  carrierCutoffs: z.partialRecord(z.enum(CUTOFFS), instant).default({}),
  pic: z.partialRecord(z.enum(OWNERS), z.string().trim().min(3).max(100)).default({}),
}).superRefine((j, ctx) => {
  const dupes = (list: string[]) => list.filter((v, i) => list.indexOf(v) !== i);
  for (const n of dupes(j.containers.map((c) => c.number))) ctx.addIssue({ code: 'custom', path: ['containers'], message: `container ${n} dobel` });
  for (const n of dupes(j.houseDocs.map((h) => h.number))) ctx.addIssue({ code: 'custom', path: ['houseDocs'], message: `house doc ${n} dobel` });
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

/** Field yang dikirim = diubah; `null` = dikosongkan. */
export const updateJobSchema = z.object({
  masterDoc: z.object(schedule).optional(),
  freeTime: freeTime.optional(),
  carrierCutoffs: z.partialRecord(z.enum(CUTOFFS), instant.nullable()).optional(),
  pic: z.partialRecord(z.enum(OWNERS), z.string().trim().min(3).max(100).nullable()).optional(),
});
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

/** Toleransi selisih jam server/klien. Milestone di masa depan hampir pasti salah ketik dan akan mematikan alarm. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

export const milestoneSchema = z.object({
  event: z.enum(MILESTONE_EVENTS),
  occurredAt: instant.refine((v) => Date.parse(v) <= Date.now() + FUTURE_TOLERANCE_MS, 'tidak boleh di masa depan'),
  // DCSA hanya lewat endpoint tracking-events.
  source: z.enum(['MANUAL', 'CEISA']).default('MANUAL'),
});
export type MilestoneInput = z.infer<typeof milestoneSchema>;

const location = z.object({ UNLocationCode: unlocode });
const classifier = z.enum(['ACT', 'EST', 'PLN']);
export const dcsaEventsSchema = z
  .array(
    z.discriminatedUnion('eventType', [
      z.object({
        eventType: z.literal('TRANSPORT'),
        eventClassifierCode: classifier,
        eventDateTime: instant,
        transportEventTypeCode: z.enum(['ARRI', 'DEPA']),
        location,
      }),
      z.object({
        eventType: z.literal('EQUIPMENT'),
        eventClassifierCode: classifier,
        eventDateTime: instant,
        equipmentEventTypeCode: z.string().regex(/^[A-Z]{4}$/),
        equipmentReference: z.string().regex(/^[A-Z]{4}\d{7}$/),
        emptyIndicatorCode: z.enum(['LADEN', 'EMPTY']),
        location,
      }),
    ]),
  )
  .min(1)
  .max(5000);

export const deadlineQuerySchema = z.object({
  owner: z.enum(OWNERS).optional(),
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',') : undefined))
    .pipe(z.array(z.enum(['DONE', 'DONE_LATE', 'SCHEDULED', 'WARNING', 'CRITICAL', 'OVERDUE', 'MISSING_DATA'])).optional()),
});
