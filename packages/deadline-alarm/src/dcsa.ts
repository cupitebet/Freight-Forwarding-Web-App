import type { MilestoneEvent, Shipment } from './types.ts';

/**
 * Subset event DCSA Track & Trace yang dipakai. Provider tracking seperti
 * trackingmcp.com / API carrier langsung menormalkan data ke standar ini.
 */
export type DcsaEvent =
  | {
      eventType: 'TRANSPORT';
      eventClassifierCode: 'ACT' | 'EST' | 'PLN';
      eventDateTime: string;
      transportEventTypeCode: 'ARRI' | 'DEPA';
      location: { UNLocationCode: string };
    }
  | {
      eventType: 'EQUIPMENT';
      eventClassifierCode: 'ACT' | 'EST' | 'PLN';
      eventDateTime: string;
      equipmentEventTypeCode: string; // LOAD, DISC, GTIN, GTOT, STUF, STRP, ...
      equipmentReference: string;
      emptyIndicatorCode: 'LADEN' | 'EMPTY';
      location: { UNLocationCode: string };
    };

export interface DcsaChange {
  field: string;
  value: string;
}

type Equip = Extract<DcsaEvent, { eventType: 'EQUIPMENT' }>;

/**
 * Terapkan event DCSA ke shipment. `events` harus RIWAYAT LENGKAP semua container shipment
 * (seperti yang dikembalikan API tracking per polling), bukan hanya event baru dari webhook;
 * kalau menerima webhook incremental, simpan event di DB lalu panggil dengan seluruh riwayatnya.
 * Aturan:
 * - Data yang sudah diisi manual TIDAK ditimpa (kecuali estimasi ETA/ETD yang di-update oleh estimasi baru).
 * - Estimasi tidak pernah menimpa aktual; event equipment hanya dari ACT.
 * - Event transport hanya dihitung di POL/POD shipment (arrival di pelabuhan transshipment diabaikan);
 *   tanpa POL/POD, event transport tidak dipakai.
 * - Milestone yang berlaku untuk seluruh shipment (gate-out, empty return, gate-in) baru terisi
 *   setelah SEMUA container mengalaminya, memakai waktu container terakhir. Bongkar memakai yang pertama.
 */
export function applyDcsaEvents(s: Shipment, events: DcsaEvent[]): { shipment: Shipment; changes: DcsaChange[] } {
  const next: Shipment = { ...s, events: { ...s.events } };
  const changes: DcsaChange[] = [];
  const ms = (iso: string) => Date.parse(iso);
  const latest = (list: DcsaEvent[]) => list.reduce<DcsaEvent | undefined>((a, e) => (!a || ms(e.eventDateTime) > ms(a.eventDateTime) ? e : a), undefined);

  const setField = (field: 'etd' | 'atd' | 'eta' | 'ata', value: string | undefined, overwrite: boolean) => {
    if (!value || (next[field] && !overwrite) || next[field] === value) return;
    next[field] = value;
    changes.push({ field, value });
  };
  const setEvent = (event: MilestoneEvent, value: string | undefined) => {
    if (!value || next.events![event]) return;
    next.events![event] = value;
    changes.push({ field: `events.${event}`, value });
  };

  const transport = (code: 'ARRI' | 'DEPA', port: string | undefined, cls: 'ACT' | 'EST') =>
    port
      ? latest(events.filter((e) => e.eventType === 'TRANSPORT' && e.transportEventTypeCode === code && e.eventClassifierCode === cls && e.location.UNLocationCode === port))
      : undefined;

  setField('atd', transport('DEPA', s.portOfLoading, 'ACT')?.eventDateTime, false);
  setField('ata', transport('ARRI', s.portOfDischarge, 'ACT')?.eventDateTime, false);
  if (!next.atd) setField('etd', transport('DEPA', s.portOfLoading, 'EST')?.eventDateTime, true);
  if (!next.ata) setField('eta', transport('ARRI', s.portOfDischarge, 'EST')?.eventDateTime, true);

  const equip = events.filter((e): e is Equip => e.eventType === 'EQUIPMENT' && e.eventClassifierCode === 'ACT');
  const containers = s.containers?.length ? s.containers : [...new Set(equip.map((e) => e.equipmentReference))];
  if (!containers.length) return { shipment: next, changes };

  const match = (code: string, empty: Equip['emptyIndicatorCode'], port?: string) =>
    equip.filter((e) => e.equipmentEventTypeCode === code && e.emptyIndicatorCode === empty && (!port || e.location.UNLocationCode === port));
  /** Waktu event per container (ambil yang paling awal per container); undefined jika belum semua container. */
  const whenAll = (list: Equip[]) => {
    const per = new Map<string, number>();
    for (const e of list) per.set(e.equipmentReference, Math.min(per.get(e.equipmentReference) ?? Infinity, ms(e.eventDateTime)));
    if (!containers.every((c) => per.has(c))) return undefined;
    return new Date(Math.max(...containers.map((c) => per.get(c)!))).toISOString();
  };
  const first = (list: Equip[]) => (list.length ? new Date(Math.min(...list.map((e) => ms(e.eventDateTime)))).toISOString() : undefined);

  if (s.direction === 'IMPORT') {
    setEvent('CONTAINER_DISCHARGED', first(match('DISC', 'LADEN', s.portOfDischarge)));
    setEvent('CONTAINER_GATE_OUT', whenAll(match('GTOT', 'LADEN', s.portOfDischarge)));
    // Empty return biasanya ke depo (lokasi bisa beda dari POD), jadi port tidak difilter.
    setEvent('EMPTY_RETURNED', whenAll(match('GTIN', 'EMPTY')));
  } else {
    setEvent('CONTAINER_GATE_IN', whenAll(match('GTIN', 'LADEN', s.portOfLoading)));
  }
  return { shipment: next, changes };
}
