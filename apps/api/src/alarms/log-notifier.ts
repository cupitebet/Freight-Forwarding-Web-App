import { Logger } from '@nestjs/common';
import { formatAlarmMessage, type Alarm, type Notifier, type Shipment } from '@ff/deadline-alarm';

/**
 * Notifier default selama belum ada kanal eksternal (Slack/WhatsApp/n8n/dst) yang dikonfigurasi
 * lewat ALARM_WEBHOOK_URL. Alarm tetap tercatat penuh di tabel `deadline_alarm_sent` — lihat
 * GET /alarms untuk membacanya lewat API — notifier ini hanya menaruhnya juga di log proses,
 * dengan level yang mengikuti urgensi supaya gampang di-filter di log aggregator apa pun.
 */
export class LogNotifier implements Notifier {
  private readonly log = new Logger('Alarm');

  async send(alarm: Alarm, shipment: Shipment): Promise<void> {
    const text = formatAlarmMessage(alarm, shipment).replace(/\n/g, ' | ');
    const line = `[${alarm.kind}] ${text} (key=${alarm.key})`;
    if (alarm.severity === 'CRITICAL') this.log.error(line);
    else if (alarm.severity === 'WARNING') this.log.warn(line);
    else this.log.log(line);
  }
}
