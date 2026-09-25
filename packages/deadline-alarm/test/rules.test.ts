import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, computeDeadlines, dueAlarms, formatAlarmMessage, type Shipment } from '../src/index.ts';

const find = (s: Shipment, code: string, now = '2026-09-01T00:00:00Z') =>
  computeDeadlines(s, DEFAULT_RULES, new Date(now)).find((d) => d.ruleCode === code);

const importNvocc = (over: Partial<Shipment> = {}): Shipment => ({
  id: 'i1', reference: 'IMP/1', direction: 'IMPORT', mode: 'SEA', roles: ['NVOCC'],
  eta: '2026-09-20T08:00:00+07:00',
  ...over,
});

test('inward manifest laut, pelayaran >= 24 jam: 24 jam sebelum kedatangan', () => {
  const d = find(importNvocc({ etd: '2026-09-15T08:00:00+08:00' }), 'IMP_INWARD_MANIFEST')!;
  assert.equal(d.dueAt, '2026-09-19T01:00:00.000Z'); // ETA 20/09 08:00 WIB - 24 jam
  assert.equal(d.estimated, false);
});

test('inward manifest laut, pelayaran < 24 jam: sebelum kedatangan', () => {
  const d = find(importNvocc({ etd: '2026-09-19T20:00:00+07:00' }), 'IMP_INWARD_MANIFEST')!;
  assert.equal(d.dueAt, '2026-09-20T01:00:00.000Z'); // = ETA
});

test('inward manifest laut tanpa ETD asal: asumsi pelayaran panjang (lebih awal) + ditandai estimasi', () => {
  const d = find(importNvocc(), 'IMP_INWARD_MANIFEST')!;
  assert.equal(d.dueAt, '2026-09-19T01:00:00.000Z');
  assert.equal(d.estimated, true);
  assert.match(d.estimateNote!, /etd asal belum diisi/);
});

test('inward manifest: ATA menggantikan ETA; pelayaran dihitung dari ATD', () => {
  const d = find(importNvocc({ atd: '2026-09-19T12:00:00+07:00', ata: '2026-09-20T02:00:00+07:00' }), 'IMP_INWARD_MANIFEST')!;
  assert.equal(d.dueAt, '2026-09-19T19:00:00.000Z'); // pelayaran 14 jam -> batas = ATA
});

test('inward manifest udara: sebelum kedatangan, rule laut tidak berlaku', () => {
  const air = importNvocc({ mode: 'AIR', etd: '2026-09-19T20:00:00+07:00' });
  assert.equal(find(air, 'IMP_INWARD_MANIFEST'), undefined);
  assert.equal(find(air, 'IMP_INWARD_MANIFEST_AIR')!.dueAt, '2026-09-20T01:00:00.000Z');
});

test('outward manifest: paling lambat sebelum keberangkatan (bukan ATD+24 jam)', () => {
  const s: Shipment = { id: 'e1', reference: 'EXP/1', direction: 'EXPORT', mode: 'SEA', roles: ['NVOCC'], etd: '2026-09-25T22:00:00+07:00' };
  assert.equal(find(s, 'EXP_OUTWARD_MANIFEST')!.dueAt, '2026-09-25T15:00:00.000Z');
});

test('PMK 155/2022: data B/L di PEB paling lama 3 hari setelah keberangkatan, pengingat hari ke-2', () => {
  const s: Shipment = { id: 'e2', reference: 'EXP/2', direction: 'EXPORT', mode: 'SEA', roles: ['PPJK'], atd: '2026-09-25T22:00:00+07:00' };
  const d = find(s, 'EXP_PEB_BL_UPDATE')!;
  assert.equal(d.dueAt, '2026-09-28T15:00:00.000Z');
  const now = new Date('2026-09-27T16:00:00Z'); // hari ke-2 setelah berangkat, < 24 jam sebelum batas
  const alarm = dueAlarms([d], DEFAULT_RULES, now)[0]!;
  assert.match(alarm.key, /:R24$/);
});

test('rekonsiliasi house B/L: batas 7 hari setelah kedatangan, pengingat hari ke-5', () => {
  const d = find(importNvocc({ ata: '2026-09-20T08:00:00+07:00' }), 'IMP_HOUSE_BL_RECONCILE')!;
  assert.equal(d.dueAt, '2026-09-27T01:00:00.000Z');
  const onDay5 = dueAlarms([{ ...d, status: 'WARNING' }], DEFAULT_RULES, new Date('2026-09-25T02:00:00Z'))[0]!;
  assert.match(onDay5.key, /:R48$/);
});

test('BTD: pengingat H-15, H-7, H-3', () => {
  const rule = DEFAULT_RULES.find((r) => r.code === 'IMP_BTD_LIMIT')!;
  assert.deepEqual(rule.remindBeforeHours.slice(0, 3), [360, 168, 72]);
});

test('notifikasi memuat risiko denda dan alasan estimasi yang spesifik', () => {
  const s = importNvocc();
  const d = find(s, 'IMP_INWARD_MANIFEST', '2026-09-18T20:00:00Z')!;
  const [alarm] = dueAlarms([d], DEFAULT_RULES, new Date('2026-09-18T20:00:00Z'));
  const msg = formatAlarmMessage(alarm!, s);
  assert.match(msg, /Risiko: Denda Rp10 jt/);
  assert.match(msg, /ESTIMASI: etd asal belum diisi/);

  const exp: Shipment = { id: 'e3', reference: 'EXP/3', direction: 'EXPORT', mode: 'SEA', roles: [], etd: '2026-09-25T22:00:00+07:00' };
  const vgm = find(exp, 'EXP_VGM_CLOSING')!;
  assert.equal(vgm.estimateNote, 'carrierCutoffs.VGM belum diisi');
});

test('setiap rule regulasi menyebut dasar hukum atau sumbernya', () => {
  for (const r of DEFAULT_RULES.filter((r) => r.category === 'BEA_CUKAI')) {
    assert.match(r.basis, /PMK|UU|SLA internal|Riset/, r.code);
  }
});
