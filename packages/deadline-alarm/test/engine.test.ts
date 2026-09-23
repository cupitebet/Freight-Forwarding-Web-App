import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RULES,
  InMemorySentAlarmStore,
  computeDeadlines,
  dueAlarms,
  runAlarmTick,
  type Alarm,
  type Notifier,
  type Shipment,
} from '../src/index.ts';

const exportShipment = (over: Partial<Shipment> = {}): Shipment => ({
  id: 'e1',
  reference: 'EXP/1',
  direction: 'EXPORT',
  mode: 'SEA',
  roles: ['PPJK'],
  etd: '2026-09-25T22:00:00+07:00',
  carrierCutoffs: { SI: '2026-09-23T12:00:00+07:00', CY: '2026-09-24T18:00:00+07:00' },
  ...over,
});

const find = (s: Shipment, code: string, now: string) =>
  computeDeadlines(s, DEFAULT_RULES, new Date(now)).find((d) => d.ruleCode === code);

test('pakai cut-off pelayaran bila ada, dan tidak ditandai estimasi', () => {
  const d = find(exportShipment(), 'EXP_SI_CLOSING', '2026-09-22T11:00:00+07:00')!;
  assert.equal(d.dueAt, '2026-09-23T05:00:00.000Z');
  assert.equal(d.estimated, false);
  assert.equal(d.status, 'SCHEDULED');
  assert.equal(d.hoursLeft, 25);
});

test('fallback ke ETD bila cut-off belum diinput, ditandai estimasi', () => {
  const d = find(exportShipment({ carrierCutoffs: {} }), 'EXP_VGM_CLOSING', '2026-09-20T00:00:00+07:00')!;
  assert.equal(d.dueAt, '2026-09-23T15:00:00.000Z'); // ETD - 48 jam
  assert.equal(d.estimated, true);
});

test('status WARNING / CRITICAL / OVERDUE mengikuti sisa waktu', () => {
  const s = exportShipment();
  assert.equal(find(s, 'EXP_SI_CLOSING', '2026-09-23T00:00:00+07:00')!.status, 'WARNING');
  assert.equal(find(s, 'EXP_SI_CLOSING', '2026-09-23T08:00:00+07:00')!.status, 'CRITICAL');
  assert.equal(find(s, 'EXP_SI_CLOSING', '2026-09-23T12:30:00+07:00')!.status, 'OVERDUE');
});

test('DONE vs DONE_LATE', () => {
  const onTime = exportShipment({ events: { SI_SUBMITTED: '2026-09-23T11:00:00+07:00' } });
  const late = exportShipment({ events: { SI_SUBMITTED: '2026-09-23T13:00:00+07:00' } });
  assert.equal(find(onTime, 'EXP_SI_CLOSING', '2026-09-24T00:00:00+07:00')!.status, 'DONE');
  assert.equal(find(late, 'EXP_SI_CLOSING', '2026-09-24T00:00:00+07:00')!.status, 'DONE_LATE');
});

test('rule berbasis peran: PEB hanya untuk PPJK, manifes hanya untuk NVOCC/agen', () => {
  const codes = (s: Shipment) => computeDeadlines(s, DEFAULT_RULES, new Date('2026-09-20T00:00:00Z')).map((d) => d.ruleCode);
  assert.ok(!codes(exportShipment({ roles: [] })).includes('EXP_PEB_NPE'));
  assert.ok(!codes(exportShipment()).includes('EXP_OUTWARD_MANIFEST'));
  assert.ok(codes(exportShipment({ roles: ['NVOCC'] })).includes('EXP_OUTWARD_MANIFEST'));
});

test('free time berakhir 23:59 waktu pelabuhan pada hari ke-N (hari bongkar = hari 1)', () => {
  const s: Shipment = {
    id: 'i1', reference: 'IMP/1', direction: 'IMPORT', mode: 'SEA', roles: [],
    eta: '2026-09-18T06:00:00+07:00',
    portUtcOffsetMinutes: 480, // WITA
    freeTime: { demurrageDays: 5 },
    events: { CONTAINER_DISCHARGED: '2026-09-18T20:00:00+08:00' },
  };
  const d = find(s, 'IMP_DEMURRAGE_FREE_TIME', '2026-09-19T00:00:00+08:00')!;
  assert.equal(d.dueAt, '2026-09-22T15:59:59.999Z'); // 22/09 23:59:59.999 WITA
});

test('detention & jalur merah baru muncul setelah event pemicunya terjadi', () => {
  const base: Shipment = {
    id: 'i2', reference: 'IMP/2', direction: 'IMPORT', mode: 'SEA', roles: ['PPJK'],
    eta: '2026-09-18T06:00:00+07:00', freeTime: { detentionDays: 7 },
  };
  const codes = (s: Shipment) => computeDeadlines(s, DEFAULT_RULES, new Date('2026-09-20T00:00:00Z')).map((d) => d.ruleCode);
  assert.ok(!codes(base).includes('IMP_DETENTION_FREE_TIME'));
  assert.ok(!codes(base).includes('IMP_RED_LANE_INSPECTION'));
  const after = { ...base, events: { CONTAINER_GATE_OUT: '2026-09-19T10:00:00+07:00', RED_LANE_ASSIGNED: '2026-09-19T12:00:00+07:00' } };
  assert.ok(codes(after).includes('IMP_DETENTION_FREE_TIME'));
  assert.ok(codes(after).includes('IMP_RED_LANE_INSPECTION'));
});

test('reminder: hanya threshold terkecil yang terlewati yang dikirim', () => {
  const s = exportShipment();
  const now = new Date('2026-09-23T07:00:00+07:00'); // 5 jam sebelum SI closing
  const alarms = dueAlarms(computeDeadlines(s, DEFAULT_RULES, now), DEFAULT_RULES, now).filter((a) => a.deadline.ruleCode === 'EXP_SI_CLOSING');
  assert.equal(alarms.length, 1);
  assert.match(alarms[0]!.key, /:R6$/);
  assert.equal(alarms[0]!.severity, 'CRITICAL');
});

test('overdue diulang & dieskalasi, lalu berhenti setelah batas maksimum', () => {
  const s = exportShipment();
  const at = (iso: string) => {
    const now = new Date(iso);
    return dueAlarms(computeDeadlines(s, DEFAULT_RULES, now), DEFAULT_RULES, now).find((a) => a.deadline.ruleCode === 'EXP_SI_CLOSING');
  };
  assert.equal(at('2026-09-23T13:00:00+07:00')!.escalate, false); // OD0
  assert.match(at('2026-09-23T17:00:00+07:00')!.key, /:OD1$/);
  assert.equal(at('2026-09-23T17:00:00+07:00')!.escalate, true);
  assert.equal(at('2026-09-25T12:00:00+07:00'), undefined); // > 6 x 4 jam
});

test('perubahan jadwal (cut-off digeser) meng-arm ulang reminder', async () => {
  const store = new InMemorySentAlarmStore();
  const sent: Alarm[] = [];
  const notifier: Notifier = { send: async (a) => void sent.push(a) };
  const now = new Date('2026-09-23T07:00:00+07:00');
  const s = exportShipment();

  await runAlarmTick({ shipments: [s], rules: DEFAULT_RULES, store, notifier, now });
  const first = sent.length;
  await runAlarmTick({ shipments: [s], rules: DEFAULT_RULES, store, notifier, now });
  assert.equal(sent.length, first, 'tick kedua tidak boleh mengirim ulang');

  const moved = exportShipment({ carrierCutoffs: { ...s.carrierCutoffs, SI: '2026-09-23T10:00:00+07:00' } });
  await runAlarmTick({ shipments: [moved], rules: DEFAULT_RULES, store, notifier, now });
  assert.ok(sent.slice(first).some((a) => a.deadline.ruleCode === 'EXP_SI_CLOSING'));
});

test('pengiriman gagal melepas klaim sehingga dicoba lagi', async () => {
  const store = new InMemorySentAlarmStore();
  let fail = true;
  const notifier: Notifier = {
    send: async () => {
      if (fail) throw new Error('webhook down');
    },
  };
  const now = new Date('2026-09-23T07:00:00+07:00');
  const r1 = await runAlarmTick({ shipments: [exportShipment()], rules: DEFAULT_RULES, store, notifier, now });
  assert.ok(r1.failed.length > 0);
  assert.equal(r1.sent.length, 0);
  fail = false;
  const r2 = await runAlarmTick({ shipments: [exportShipment()], rules: DEFAULT_RULES, store, notifier, now });
  assert.equal(r2.sent.length, r1.failed.length);
});

test('alarm data kurang: sekali per hari (WIB), jadi muncul lagi setelah data diisi lalu dihapus', () => {
  const s = exportShipment(); // tanpa cut-off DRAFT_BL
  const keyAt = (iso: string) => {
    const now = new Date(iso);
    return dueAlarms(computeDeadlines(s, DEFAULT_RULES, now), DEFAULT_RULES, now).find((a) => a.kind === 'MISSING_DATA')!.key;
  };
  assert.equal(keyAt('2026-09-23T08:00:00+07:00'), keyAt('2026-09-23T23:00:00+07:00'));
  assert.notEqual(keyAt('2026-09-23T23:00:00+07:00'), keyAt('2026-09-24T00:30:00+07:00'));
  assert.match(keyAt('2026-09-23T08:00:00+07:00'), /:MISSING:carrierCutoffs\.DRAFT_BL:2026-09-23$/);
});

test('alarm hanya ditandai terkirim setelah notifier sukses (confirm dipanggil sesudah send)', async () => {
  const calls: string[] = [];
  const store = {
    claim: async () => (calls.push('claim'), true),
    confirm: async () => void calls.push('confirm'),
    release: async () => void calls.push('release'),
  };
  const notifier: Notifier = { send: async () => void calls.push('send') };
  await runAlarmTick({ shipments: [exportShipment()], rules: [DEFAULT_RULES[0]!], store, notifier, now: new Date('2026-09-23T07:00:00+07:00') });
  assert.deepEqual(calls, ['claim', 'send', 'confirm']);
});
