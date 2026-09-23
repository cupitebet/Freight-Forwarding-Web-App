import { computeDeadlines, dueAlarms } from './engine.ts';
import type { Notifier, SentAlarmStore } from './notifier.ts';
import type { Alarm, DeadlineRule, Shipment } from './types.ts';

export interface TickResult {
  sent: Alarm[];
  failed: { alarm: Alarm; error: unknown }[];
}

/**
 * Satu putaran pengecekan. Jalankan tiap 5 menit (cron, BullMQ repeatable job,
 * atau Schedule Trigger n8n). Aman dijalankan paralel di beberapa instance
 * karena setiap alarm diklaim dulu di `store` sebelum dikirim.
 */
export async function runAlarmTick(opts: {
  shipments: Shipment[];
  rules: DeadlineRule[];
  store: SentAlarmStore;
  notifier: Notifier;
  now?: Date;
}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const result: TickResult = { sent: [], failed: [] };

  for (const shipment of opts.shipments) {
    const alarms = dueAlarms(computeDeadlines(shipment, opts.rules, now), opts.rules, now);
    for (const alarm of alarms) {
      if (!(await opts.store.claim(alarm.key))) continue;
      try {
        await opts.notifier.send(alarm, shipment);
        result.sent.push(alarm);
      } catch (error) {
        await opts.store.release(alarm.key);
        result.failed.push({ alarm, error });
      }
    }
  }
  return result;
}
