/**
 * Demo: `npm run demo` — tampilkan deadline & alarm untuk dua shipment contoh.
 */
import { DEFAULT_RULES } from './rules.ts';
import { computeDeadlines } from './engine.ts';
import { ConsoleNotifier, InMemorySentAlarmStore } from './notifier.ts';
import { runAlarmTick } from './scheduler.ts';
import type { Shipment } from './types.ts';

const now = new Date('2026-09-23T09:00:00+07:00');

const shipments: Shipment[] = [
  {
    id: 'shp-exp-001',
    reference: 'EXP/2609/0012',
    direction: 'EXPORT',
    mode: 'SEA',
    roles: ['PPJK', 'NVOCC'],
    vesselName: 'KMTC JAKARTA',
    voyage: '2609N',
    etd: '2026-09-25T22:00:00+07:00',
    carrierCutoffs: {
      SI: '2026-09-23T12:00:00+07:00',
      VGM: '2026-09-24T12:00:00+07:00',
      CY: '2026-09-24T18:00:00+07:00',
    },
    events: { VGM_SUBMITTED: '2026-09-22T15:00:00+07:00' },
    pic: { DOCS: 'wa:+6281200000001', CUSTOMS: 'wa:+6281200000002', OPS: 'wa:+6281200000003' },
  },
  {
    id: 'shp-imp-001',
    reference: 'IMP/2609/0007',
    direction: 'IMPORT',
    mode: 'SEA',
    roles: ['PPJK', 'NVOCC'],
    vesselName: 'MERATUS BATAM',
    voyage: '114S',
    eta: '2026-09-18T06:00:00+07:00',
    ata: '2026-09-18T10:00:00+07:00',
    freeTime: { demurrageDays: 5, detentionDays: 7, storageDays: 3 },
    events: {
      INWARD_MANIFEST_SUBMITTED: '2026-09-17T09:00:00+07:00',
      PIB_SUBMITTED: '2026-09-19T11:00:00+07:00',
      CONTAINER_DISCHARGED: '2026-09-18T20:00:00+07:00',
      RED_LANE_ASSIGNED: '2026-09-22T14:00:00+07:00',
    },
    pic: { OPS: 'wa:+6281200000003', CUSTOMS: 'wa:+6281200000002' },
  },
];

for (const s of shipments) {
  console.log(`\n=== ${s.reference} (${s.direction}) ===`);
  console.table(
    computeDeadlines(s, DEFAULT_RULES, now).map((d) => ({
      rule: d.ruleCode,
      status: d.status,
      dueAt: d.dueAt,
      est: d.estimated ? 'ya' : '',
      hoursLeft: d.hoursLeft ?? '',
      missing: d.missing?.join(', ') ?? '',
    })),
  );
}

console.log('\n=== Alarm yang dikirim pada tick ini ===\n');
const result = await runAlarmTick({
  shipments,
  rules: DEFAULT_RULES,
  store: new InMemorySentAlarmStore(),
  notifier: new ConsoleNotifier(),
  now,
});
console.log(`Terkirim: ${result.sent.length}, gagal: ${result.failed.length}`);
