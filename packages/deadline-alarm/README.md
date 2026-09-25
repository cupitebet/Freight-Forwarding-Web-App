# @ff/deadline-alarm

Alarm cut-off dan deadline untuk freight forwarding: closing SI/VGM/CY ke pelayaran, PEB/NPE, manifes BC 1.1 (inward/outward), RKSP, PIB, jalur merah, free time storage/demurrage/detention, dan batas BTD.

Modul ini framework-agnostic (TypeScript murni, tanpa dependency runtime), jadi bisa dipasang di service NestJS, di worker BullMQ, atau dipanggil dari n8n. Tidak butuh n8n atau kanal eksternal apa pun — `apps/api` memakainya langsung, dan alarm log-only (tercatat di database, dibaca lewat `GET /alarms`) sampai kanal notifikasi nyata (Slack/WhatsApp/email/n8n) dikonfigurasi.

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
import { DEFAULT_RULES, runAlarmTick } from '@ff/deadline-alarm';

// dipanggil tiap 5 menit (cron / BullMQ repeatable job / n8n Schedule Trigger — bebas, tidak wajib n8n)
await runAlarmTick({
  shipments: await shipmentRepo.findActive(),         // map dari tabel shipment
  rules: await ruleRepo.load() ?? DEFAULT_RULES,       // tabel deadline_rule
  store: new PgSentAlarmStore(pool),                   // lihat apps/api/src/alarms
  notifier,                                            // LogNotifier (default) atau WebhookNotifier — lihat "Kanal notifikasi" di bawah
});
```

- `computeDeadlines(shipment, rules, now)` mengembalikan daftar deadline beserta statusnya (`SCHEDULED`/`WARNING`/`CRITICAL`/`OVERDUE`/`DONE`/`DONE_LATE`/`MISSING_DATA`), untuk ditampilkan di dashboard.
- `dueAlarms(deadlines, rules, now)` adalah fungsi murni yang menghasilkan alarm berikut key idempotennya.
- Core App cukup mengisi `shipment.events.X` saat pekerjaan selesai (mis. `SI_SUBMITTED` ketika SI dikirim, `INWARD_MANIFEST_SUBMITTED` ketika respon CEISA sukses). Deadline terkait langsung dianggap selesai dan alarm berhenti.

- `applyDcsaEvents(shipment, events)` mengisi ETA/ATA, bongkar, gate-out/in, dan empty return dari event tracking berformat DCSA (API carrier atau provider tracking). Kirim riwayat event lengkap, bukan hanya event baru.

## Kanal notifikasi

`Notifier` cuma satu method (`send(alarm, shipment)`), jadi kanal apa pun tinggal diimplementasikan langsung — gak perlu n8n sebagai perantara:

- **`LogNotifier`** (di `apps/api/src/alarms`, default): alarm ditulis ke log proses. Semua alarm juga selalu tercatat penuh di tabel `deadline_alarm_sent` terlepas dari notifier yang dipakai, dan bisa dibaca lewat `GET /alarms` di `apps/api`.
- **`ConsoleNotifier`** (di modul ini): mirip, untuk demo/skrip di luar NestJS.
- **`WebhookNotifier`** (di modul ini): POST JSON bertanda tangan HMAC ke satu URL — bisa n8n, Slack Incoming Webhook, endpoint WhatsApp Cloud API custom, atau apa pun. Set `ALARM_WEBHOOK_URL` + `ALARM_WEBHOOK_SECRET` di `apps/api/.env`.
- **Kanal lain** (Slack API, email SMTP, WhatsApp Cloud API langsung): implementasikan `Notifier` sendiri di `apps/api/src/alarms/`, lalu pasang di `alarms.module.ts`. Payload sudah punya `formatAlarmMessage(alarm, shipment)` siap pakai dan `shipment.pic[owner]` untuk tujuan pengiriman.

Lihat `docs/REVIEW.md` di root repo untuk daftar rule dan catatan verifikasi regulasi.
