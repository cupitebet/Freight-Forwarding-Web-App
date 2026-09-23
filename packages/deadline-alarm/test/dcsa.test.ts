import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, applyDcsaEvents, computeDeadlines, type DcsaEvent, type Shipment } from '../src/index.ts';

const imp: Shipment = {
  id: 'i1', reference: 'IMP/1', direction: 'IMPORT', mode: 'SEA', roles: [],
  portOfLoading: 'SGSIN', portOfDischarge: 'IDJKT',
  containers: ['MSCU0000001', 'MSCU0000002'],
  eta: '2026-09-18T06:00:00+07:00',
  freeTime: { demurrageDays: 5, detentionDays: 7 },
};

const tr = (code: 'ARRI' | 'DEPA', cls: 'ACT' | 'EST', port: string, at: string): DcsaEvent => ({
  eventType: 'TRANSPORT', eventClassifierCode: cls, transportEventTypeCode: code, eventDateTime: at, location: { UNLocationCode: port },
});
const eq = (code: string, ref: string, empty: 'LADEN' | 'EMPTY', port: string, at: string): DcsaEvent => ({
  eventType: 'EQUIPMENT', eventClassifierCode: 'ACT', equipmentEventTypeCode: code, equipmentReference: ref, emptyIndicatorCode: empty, eventDateTime: at, location: { UNLocationCode: port },
});

test('ATA hanya dari arrival di POD, transshipment diabaikan', () => {
  const { shipment } = applyDcsaEvents(imp, [
    tr('ARRI', 'ACT', 'MYPKG', '2026-09-15T08:00:00Z'),
    tr('ARRI', 'ACT', 'IDJKT', '2026-09-18T03:30:00Z'),
  ]);
  assert.equal(shipment.ata, '2026-09-18T03:30:00Z');
});

test('ETA estimasi baru meng-update ETA, tapi tidak dipakai jika sudah ada ATA', () => {
  const r1 = applyDcsaEvents(imp, [tr('ARRI', 'EST', 'IDJKT', '2026-09-19T00:00:00Z')]);
  assert.equal(r1.shipment.eta, '2026-09-19T00:00:00Z');
  const r2 = applyDcsaEvents({ ...imp, ata: '2026-09-18T03:30:00Z' }, [tr('ARRI', 'EST', 'IDJKT', '2026-09-19T00:00:00Z')]);
  assert.equal(r2.shipment.eta, imp.eta);
});

test('gate-out baru terisi setelah SEMUA container keluar (pakai waktu terakhir); bongkar pakai yang pertama', () => {
  const history = [
    eq('DISC', 'MSCU0000002', 'LADEN', 'IDJKT', '2026-09-18T12:00:00Z'),
    eq('DISC', 'MSCU0000001', 'LADEN', 'IDJKT', '2026-09-18T10:00:00Z'),
    eq('GTOT', 'MSCU0000001', 'LADEN', 'IDJKT', '2026-09-20T02:00:00Z'),
  ];
  const partial = applyDcsaEvents(imp, history);
  assert.equal(partial.shipment.events?.CONTAINER_DISCHARGED, '2026-09-18T10:00:00.000Z');
  assert.equal(partial.shipment.events?.CONTAINER_GATE_OUT, undefined);

  const all = applyDcsaEvents(partial.shipment, [...history, eq('GTOT', 'MSCU0000002', 'LADEN', 'IDJKT', '2026-09-21T05:00:00Z')]);
  assert.equal(all.shipment.events?.CONTAINER_GATE_OUT, '2026-09-21T05:00:00.000Z');
  assert.deepEqual(all.changes, [{ field: 'events.CONTAINER_GATE_OUT', value: '2026-09-21T05:00:00.000Z' }]);
});

test('data manual tidak ditimpa, dan event tracking langsung mengubah status alarm', () => {
  const manual = { ...imp, events: { CONTAINER_DISCHARGED: '2026-09-18T09:00:00Z' } };
  const { shipment } = applyDcsaEvents(manual, [
    eq('DISC', 'MSCU0000001', 'LADEN', 'IDJKT', '2026-09-18T10:00:00Z'),
    eq('GTOT', 'MSCU0000001', 'LADEN', 'IDJKT', '2026-09-20T02:00:00Z'),
    eq('GTOT', 'MSCU0000002', 'LADEN', 'IDJKT', '2026-09-20T03:00:00Z'),
  ]);
  assert.equal(shipment.events?.CONTAINER_DISCHARGED, '2026-09-18T09:00:00Z');
  const dm = computeDeadlines(shipment, DEFAULT_RULES, new Date('2026-09-25T00:00:00Z')).find((d) => d.ruleCode === 'IMP_DEMURRAGE_FREE_TIME')!;
  assert.equal(dm.status, 'DONE');
  const det = computeDeadlines(shipment, DEFAULT_RULES, new Date('2026-09-25T00:00:00Z')).find((d) => d.ruleCode === 'IMP_DETENTION_FREE_TIME')!;
  assert.equal(det.status, 'SCHEDULED');
});

test('ekspor: gate-in full di POL untuk semua container menutup CY closing', () => {
  const exp: Shipment = { ...imp, direction: 'EXPORT', portOfLoading: 'IDJKT', portOfDischarge: 'SGSIN', carrierCutoffs: { CY: '2026-09-24T18:00:00+07:00' } };
  const { shipment } = applyDcsaEvents(exp, [
    eq('GTIN', 'MSCU0000001', 'LADEN', 'IDJKT', '2026-09-24T01:00:00Z'),
    eq('GTIN', 'MSCU0000002', 'LADEN', 'IDJKT', '2026-09-24T02:00:00Z'),
  ]);
  const cy = computeDeadlines(shipment, DEFAULT_RULES, new Date('2026-09-24T05:00:00Z')).find((d) => d.ruleCode === 'EXP_CY_CLOSING')!;
  assert.equal(cy.status, 'DONE');
});
