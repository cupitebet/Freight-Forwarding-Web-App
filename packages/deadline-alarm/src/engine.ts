import type { Alarm, Anchor, Deadline, DeadlineRule, DeadlineStatus, Shipment } from './types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEFAULT_UTC_OFFSET_MIN = 420; // WIB
const WARNING_WITHIN_HOURS = 24;
const CRITICAL_WITHIN_HOURS = 6;
const DEFAULT_OVERDUE_REPEAT_HOURS = 4;
const DEFAULT_MAX_OVERDUE_ALARMS = 6;

function parse(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Tanggal tidak valid: ${iso}`);
  return ms;
}

type Resolved = { at: number } | { missing: string[] };

/**
 * Akhir hari ke-`days` (23:59:59.999 waktu pelabuhan), menghitung hari `startMs` sebagai hari ke-1.
 * Indonesia tidak memakai DST sehingga offset tetap per pelabuhan sudah akurat.
 */
function endOfFreeTime(startMs: number, days: number, utcOffsetMin: number): number {
  const offset = utcOffsetMin * 60_000;
  const localMidnight = Math.floor((startMs + offset) / DAY) * DAY;
  return localMidnight + days * DAY - 1 - offset;
}

function resolveAnchor(anchor: Anchor, s: Shipment): Resolved {
  const ev = s.events ?? {};
  switch (anchor.kind) {
    case 'CARRIER_CUTOFF': {
      const at = parse(s.carrierCutoffs?.[anchor.cutoff]);
      return at === undefined ? { missing: [`carrierCutoffs.${anchor.cutoff}`] } : { at };
    }
    case 'DEPARTURE': {
      const base = parse(s.atd) ?? parse(s.etd);
      return base === undefined ? { missing: ['etd'] } : { at: base + anchor.offsetHours * HOUR };
    }
    case 'ARRIVAL': {
      const base = parse(s.ata) ?? parse(s.eta);
      return base === undefined ? { missing: ['eta'] } : { at: base + anchor.offsetHours * HOUR };
    }
    case 'EVENT': {
      const base = parse(ev[anchor.event]);
      return base === undefined ? { missing: [`events.${anchor.event}`] } : { at: base + anchor.offsetHours * HOUR };
    }
    case 'FREE_TIME': {
      const days = s.freeTime?.[anchor.days];
      const start = anchor.from === 'ARRIVAL' ? (parse(s.ata) ?? parse(s.eta)) : parse(ev[anchor.from]);
      const missing = [
        ...(days === undefined ? [`freeTime.${anchor.days}`] : []),
        ...(start === undefined ? [anchor.from === 'ARRIVAL' ? 'eta' : `events.${anchor.from}`] : []),
      ];
      if (missing.length) return { missing };
      return { at: endOfFreeTime(start!, days!, s.portUtcOffsetMinutes ?? DEFAULT_UTC_OFFSET_MIN) };
    }
  }
}

export function ruleApplies(rule: DeadlineRule, s: Shipment): boolean {
  if (!rule.directions.includes(s.direction)) return false;
  if (!rule.modes.includes(s.mode)) return false;
  if (rule.roles && !rule.roles.some((r) => s.roles.includes(r))) return false;
  // Rule yang dipicu event (jalur merah, detention sejak gate-out) baru muncul setelah event-nya terjadi.
  const a = rule.anchor;
  const trigger = a.kind === 'EVENT' ? a.event : a.kind === 'FREE_TIME' && a.from !== 'ARRIVAL' ? a.from : undefined;
  if (trigger && !rule.fallback && !s.events?.[trigger]) return false;
  return true;
}

export function computeDeadlines(s: Shipment, rules: DeadlineRule[], now: Date): Deadline[] {
  const nowMs = now.getTime();
  return rules.filter((r) => ruleApplies(r, s)).map((rule) => {
    const base = {
      shipmentId: s.id,
      ruleCode: rule.code,
      title: rule.title,
      category: rule.category,
      owner: rule.owner,
      basis: rule.basis,
    };

    let resolved = resolveAnchor(rule.anchor, s);
    let estimated = false;
    if ('missing' in resolved && rule.fallback) {
      const fb = resolveAnchor(rule.fallback, s);
      if ('at' in fb) {
        resolved = fb;
        estimated = true;
      }
    }

    const completedIso = s.events?.[rule.doneWhen];
    const completedMs = parse(completedIso);
    const dueMs = 'at' in resolved ? resolved.at : undefined;

    let status: DeadlineStatus;
    if (completedMs !== undefined) {
      status = dueMs !== undefined && completedMs > dueMs ? 'DONE_LATE' : 'DONE';
    } else if (dueMs === undefined) {
      status = 'MISSING_DATA';
    } else {
      const left = (dueMs - nowMs) / HOUR;
      status = left < 0 ? 'OVERDUE' : left <= CRITICAL_WITHIN_HOURS ? 'CRITICAL' : left <= WARNING_WITHIN_HOURS ? 'WARNING' : 'SCHEDULED';
    }

    const d: Deadline = { ...base, status, dueAt: dueMs === undefined ? null : new Date(dueMs).toISOString(), estimated };
    if (completedIso) d.completedAt = completedIso;
    if (dueMs !== undefined && completedMs === undefined) d.hoursLeft = Math.round(((dueMs - nowMs) / HOUR) * 10) / 10;
    if ('missing' in resolved) d.missing = resolved.missing;
    return d;
  });
}

/**
 * Alarm yang "jatuh tempo" pada waktu `now`. Fungsi ini murni & idempoten:
 * scheduler memanggilnya tiap tick dan menyaring `key` yang sudah terkirim.
 *
 * - REMINDER: hanya threshold TERKECIL yang sudah terlewati yang dikirim, jadi
 *   shipment yang baru diinput mepet deadline tidak mem-banjiri semua reminder.
 * - `dueAt` masuk ke key: kalau ETD/ETA/cut-off berubah, reminder otomatis di-arm ulang.
 * - OVERDUE: diulang tiap `overdueRepeatHours`, alarm ke-2 dst. dieskalasi.
 */
export function dueAlarms(deadlines: Deadline[], rules: DeadlineRule[], now: Date): Alarm[] {
  const nowMs = now.getTime();
  const byCode = new Map(rules.map((r) => [r.code, r]));
  const alarms: Alarm[] = [];

  for (const d of deadlines) {
    const rule = byCode.get(d.ruleCode);
    if (!rule || d.status === 'DONE' || d.status === 'DONE_LATE') continue;
    const prefix = `${d.shipmentId}:${d.ruleCode}`;

    if (d.status === 'MISSING_DATA') {
      alarms.push({ key: `${prefix}:MISSING:${(d.missing ?? []).join(',')}`, kind: 'MISSING_DATA', severity: 'INFO', escalate: false, deadline: d });
      continue;
    }

    const dueMs = Date.parse(d.dueAt!);
    if (nowMs < dueMs) {
      const crossed = rule.remindBeforeHours.filter((h) => nowMs >= dueMs - h * HOUR);
      if (!crossed.length) continue;
      const h = Math.min(...crossed);
      alarms.push({
        key: `${prefix}:${d.dueAt}:R${h}`,
        kind: 'REMINDER',
        severity: h <= CRITICAL_WITHIN_HOURS ? 'CRITICAL' : 'WARNING',
        escalate: false,
        deadline: d,
      });
    } else {
      const repeat = rule.overdueRepeatHours ?? DEFAULT_OVERDUE_REPEAT_HOURS;
      const n = Math.floor((nowMs - dueMs) / (repeat * HOUR));
      if (n >= (rule.maxOverdueAlarms ?? DEFAULT_MAX_OVERDUE_ALARMS)) continue;
      alarms.push({ key: `${prefix}:${d.dueAt}:OD${n}`, kind: 'OVERDUE', severity: 'CRITICAL', escalate: n >= 1, deadline: d });
    }
  }
  return alarms;
}
