import type { Alarm, Shipment } from './types.ts';

export interface Notifier {
  send(alarm: Alarm, shipment: Shipment): Promise<void>;
}

/**
 * Penyimpan alarm yang sudah terkirim. Di produksi pakai tabel
 * `deadline_alarm_sent` (lihat sql/001_deadline_alarm.sql) dengan
 * `INSERT ... ON CONFLICT DO NOTHING` sehingga aman untuk banyak worker.
 */
export interface SentAlarmStore {
  /** true jika key berhasil diklaim (belum pernah dikirim). */
  claim(key: string): Promise<boolean>;
  /** Lepas klaim jika pengiriman gagal, supaya dicoba lagi di tick berikutnya. */
  release(key: string): Promise<void>;
}

export class InMemorySentAlarmStore implements SentAlarmStore {
  private readonly keys = new Set<string>();
  async claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
  async release(key: string): Promise<void> {
    this.keys.delete(key);
  }
}

function fmtLocal(iso: string, utcOffsetMin: number): string {
  const d = new Date(Date.parse(iso) + utcOffsetMin * 60_000);
  const zone = utcOffsetMin === 480 ? 'WITA' : utcOffsetMin === 540 ? 'WIT' : utcOffsetMin === 420 ? 'WIB' : `UTC${utcOffsetMin >= 0 ? '+' : ''}${utcOffsetMin / 60}`;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ${zone}`;
}

/** Pesan singkat berbahasa Indonesia untuk WhatsApp / Slack / email. */
export function formatAlarmMessage(alarm: Alarm, s: Shipment): string {
  const d = alarm.deadline;
  const offset = s.portUtcOffsetMinutes ?? 420;
  const vessel = [s.vesselName, s.voyage].filter(Boolean).join(' / ');
  const head = `[${s.reference}]${vessel ? ` ${vessel}` : ''}`;
  const est = d.estimated ? ' (ESTIMASI — cut-off pelayaran belum diinput)' : '';

  switch (alarm.kind) {
    case 'MISSING_DATA':
      return `ℹ️ ${head}\n${d.title}\nDeadline belum bisa dihitung. Lengkapi: ${(d.missing ?? []).join(', ')}.`;
    case 'REMINDER':
      return `${alarm.severity === 'CRITICAL' ? '🔴' : '🟡'} ${head}\n${d.title}\nBatas: ${fmtLocal(d.dueAt!, offset)}${est}\nSisa: ${d.hoursLeft} jam — PIC ${d.owner}.`;
    case 'OVERDUE':
      return `🚨 TERLAMBAT ${head}\n${d.title}\nBatas: ${fmtLocal(d.dueAt!, offset)}${est}\nLewat ${Math.abs(d.hoursLeft ?? 0)} jam.${alarm.escalate ? ' Eskalasi ke supervisor.' : ''}`;
  }
}

/**
 * Kirim alarm ke webhook n8n (sesuai blueprint: n8n yang meneruskan ke
 * WhatsApp/Slack/email). Payload berisi teks siap kirim + data terstruktur.
 */
export class WebhookNotifier implements Notifier {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  async send(alarm: Alarm, shipment: Shipment): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({
        key: alarm.key,
        kind: alarm.kind,
        severity: alarm.severity,
        escalate: alarm.escalate,
        recipient: shipment.pic?.[alarm.deadline.owner] ?? null,
        text: formatAlarmMessage(alarm, shipment),
        shipment: { id: shipment.id, reference: shipment.reference },
        deadline: alarm.deadline,
      }),
    });
    if (!res.ok) throw new Error(`Webhook ${res.status}: ${await res.text()}`);
  }
}

export class ConsoleNotifier implements Notifier {
  async send(alarm: Alarm, shipment: Shipment): Promise<void> {
    console.log(`${formatAlarmMessage(alarm, shipment)}\n  -> ${shipment.pic?.[alarm.deadline.owner] ?? alarm.deadline.owner}\n`);
  }
}
