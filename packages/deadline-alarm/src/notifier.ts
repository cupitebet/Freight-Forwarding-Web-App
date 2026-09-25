import { createHmac } from 'node:crypto';
import type { Alarm, Shipment } from './types.ts';

export interface Notifier {
  send(alarm: Alarm, shipment: Shipment): Promise<void>;
}

/**
 * Penyimpan alarm yang sudah terkirim, dengan `alarm.key` sebagai kunci unik.
 * Implementasi PostgreSQL ada di apps/api (tabel `deadline_alarm_sent`,
 * `INSERT ... ON CONFLICT DO NOTHING`) sehingga aman untuk banyak worker.
 */
export interface SentAlarmStore {
  /**
   * true jika alarm berhasil diklaim untuk dikirim: belum pernah terkirim dan tidak sedang
   * diklaim pengirim lain. Klaim harus berupa lease yang kedaluwarsa, supaya alarm yang
   * klaimnya tertinggal (proses mati sebelum `confirm`) dikirim ulang, bukan hilang.
   */
  claim(alarm: Alarm): Promise<boolean>;
  /** Tandai terkirim setelah notifier sukses. */
  confirm(alarm: Alarm): Promise<void>;
  /** Lepas klaim jika pengiriman gagal, supaya dicoba lagi di tick berikutnya. */
  release(alarm: Alarm): Promise<void>;
}

export class InMemorySentAlarmStore implements SentAlarmStore {
  private readonly keys = new Set<string>();
  async claim(alarm: Alarm): Promise<boolean> {
    if (this.keys.has(alarm.key)) return false;
    this.keys.add(alarm.key);
    return true;
  }
  async confirm(): Promise<void> {}
  async release(alarm: Alarm): Promise<void> {
    this.keys.delete(alarm.key);
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
  const est = d.estimated ? ` (ESTIMASI: ${d.estimateNote ?? 'data acuan belum lengkap'})` : '';
  const risk = d.risk ? `\nRisiko: ${d.risk}` : '';

  switch (alarm.kind) {
    case 'MISSING_DATA':
      return `ℹ️ ${head}\n${d.title}\nDeadline belum bisa dihitung. Lengkapi: ${(d.missing ?? []).join(', ')}.`;
    case 'REMINDER':
      return `${alarm.severity === 'CRITICAL' ? '🔴' : '🟡'} ${head}\n${d.title}\nBatas: ${fmtLocal(d.dueAt!, offset)}${est}\nSisa: ${d.hoursLeft} jam — PIC ${d.owner}.${risk}`;
    case 'OVERDUE':
      return `🚨 TERLAMBAT ${head}\n${d.title}\nBatas: ${fmtLocal(d.dueAt!, offset)}${est}\nLewat ${Math.abs(d.hoursLeft ?? 0)} jam.${alarm.escalate ? ' Eskalasi ke supervisor.' : ''}${risk}`;
  }
}

export interface WebhookNotifierOptions {
  /** Secret bersama dengan n8n. Jika diisi, request ditandatangani HMAC-SHA256. */
  secret?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Tanda tangan webhook: `x-ff-signature: sha256=<hex HMAC(secret, "<timestamp>.<body>")>`
 * dan `x-ff-timestamp: <unix detik>`. Penerima wajib menolak timestamp yang
 * selisihnya > 5 menit (anti-replay) dan membandingkan signature secara constant-time.
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Kirim alarm ke webhook n8n (sesuai blueprint: n8n yang meneruskan ke
 * WhatsApp/Slack/email). Payload berisi teks siap kirim + data terstruktur.
 */
export class WebhookNotifier implements Notifier {
  private readonly url: string;
  private readonly opts: WebhookNotifierOptions;

  constructor(url: string, opts: WebhookNotifierOptions = {}) {
    this.url = url;
    this.opts = opts;
  }

  async send(alarm: Alarm, shipment: Shipment): Promise<void> {
    const body = JSON.stringify({
      key: alarm.key,
      kind: alarm.kind,
      severity: alarm.severity,
      escalate: alarm.escalate,
      recipient: shipment.pic?.[alarm.deadline.owner] ?? null,
      text: formatAlarmMessage(alarm, shipment),
      shipment: { id: shipment.id, reference: shipment.reference },
      deadline: alarm.deadline,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.opts.headers };
    if (this.opts.secret) {
      const ts = Math.floor(Date.now() / 1000);
      headers['x-ff-timestamp'] = String(ts);
      headers['x-ff-signature'] = signWebhook(this.opts.secret, body, ts);
    }
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`Webhook ${res.status}: ${await res.text()}`);
  }
}

export class ConsoleNotifier implements Notifier {
  async send(alarm: Alarm, shipment: Shipment): Promise<void> {
    console.log(`${formatAlarmMessage(alarm, shipment)}\n  -> ${shipment.pic?.[alarm.deadline.owner] ?? alarm.deadline.owner}\n`);
  }
}
