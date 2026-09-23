# @ff/deadline-alarm

Alarm cut-off dan deadline untuk freight forwarding: closing SI/VGM/CY ke pelayaran, PEB/NPE, manifes BC 1.1 (inward/outward), RKSP, PIB, jalur merah, free time storage/demurrage/detention, dan batas BTD.

Modul ini framework-agnostic (TypeScript murni, tanpa dependency runtime), jadi bisa dipasang di service NestJS, di worker BullMQ, atau dipanggil dari n8n.

## Menjalankan

Butuh Node ≥ 22.18 (menjalankan `.ts` langsung).

```bash
npm install
npm test          # unit test (node:test)
npm run typecheck
npm run demo      # contoh 1 shipment ekspor + 1 impor
```

## Integrasi

```ts
import { DEFAULT_RULES, runAlarmTick, WebhookNotifier } from '@ff/deadline-alarm';

// dipanggil tiap 5 menit (cron / BullMQ repeatable / n8n Schedule Trigger)
await runAlarmTick({
  shipments: await shipmentRepo.findActive(),         // map dari tabel shipment
  rules: await ruleRepo.load() ?? DEFAULT_RULES,       // tabel deadline_rule
  store: new PgSentAlarmStore(pool),                   // lihat apps/api/src/alarms
  notifier: new WebhookNotifier(process.env.N8N_ALARM_WEBHOOK_URL!, { secret: process.env.ALARM_WEBHOOK_SECRET }),
});
```

- `computeDeadlines(shipment, rules, now)` mengembalikan daftar deadline beserta statusnya (`SCHEDULED`/`WARNING`/`CRITICAL`/`OVERDUE`/`DONE`/`DONE_LATE`/`MISSING_DATA`), untuk ditampilkan di dashboard.
- `dueAlarms(deadlines, rules, now)` adalah fungsi murni yang menghasilkan alarm berikut key idempotennya.
- Core App cukup mengisi `shipment.events.X` saat pekerjaan selesai (mis. `SI_SUBMITTED` ketika SI dikirim, `INWARD_MANIFEST_SUBMITTED` ketika respon CEISA sukses). Deadline terkait langsung dianggap selesai dan alarm berhenti.

- `applyDcsaEvents(shipment, events)` mengisi ETA/ATA, bongkar, gate-out/in, dan empty return dari event tracking berformat DCSA (API carrier atau provider tracking). Kirim riwayat event lengkap, bukan hanya event baru.

Payload webhook berisi `text` yang siap diteruskan n8n ke WhatsApp/Slack, `recipient` dari `shipment.pic[owner]`, dan flag `escalate`.

Lihat `docs/REVIEW.md` di root repo untuk daftar rule dan catatan verifikasi regulasi.
