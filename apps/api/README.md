# @ff/api

Core API (NestJS 12 + PostgreSQL) untuk job forwarding, milestone, tracking DCSA, dan scheduler alarm deadline dari `@ff/deadline-alarm`.

## Menjalankan lokal

Windows: lihat `docs/LOCAL-WINDOWS.md`. Linux/macOS, dari root repo:

```bash
npm ci
cp .env.example .env                      # isi API_KEYS (openssl rand -hex 24)
docker compose up -d db                   # juga membuat database ff_test
npm run build
npm run migrate
npm start
```

`npm start`, `npm run migrate`, dan `npm test` otomatis membaca `.env` di root repo. Variabel environment yang sudah di-set tetap diutamakan.

Test e2e memakai database sungguhan dan **menghapus seluruh isi schema `public`** di `TEST_DATABASE_URL`. Karena itu nama database wajib berakhiran `_test`.

## Endpoint

Semua endpoint wajib header `x-api-key`, kecuali `GET /health`. Waktu wajib ISO 8601 **dengan offset** (`2026-09-25T22:00:00+07:00`). Kalau offset tidak ada, request ditolak supaya WIB/WITA/WIT tidak tertukar.

| Method & path | Fungsi |
|---|---|
| `POST /jobs` | Buat job: arah, moda, peran (PPJK/NVOCC/CARRIER_AGENT), MBL/MAWB + jadwal kapal, HBL, container, cut-off pelayaran, free time, PIC. |
| `GET /jobs/:id` | Detail job + daftar deadline beserta statusnya. |
| `PATCH /jobs/:id` | Ubah jadwal kapal, cut-off, free time, atau PIC. Nilai `null` = hapus. Alarm otomatis menyesuaikan. |
| `POST /jobs/:id/close` | Tutup job (alarm berhenti). |
| `POST /jobs/:id/milestones` | `{ event, occurredAt, source? }`. Mencatat pekerjaan selesai (mis. `SI_SUBMITTED`, `NPE_ISSUED`). Mengirim ulang = koreksi; nilai lama dikembalikan di `previous`. |
| `DELETE /jobs/:id/milestones/:event` | Hapus milestone yang salah input. |
| `POST /jobs/:id/tracking-events` | Array event DCSA Track & Trace. Boleh incremental (webhook) atau riwayat penuh (polling); event duplikat diabaikan. |
| `GET /deadlines?owner=DOCS&status=OVERDUE,CRITICAL` | Tampilan "Hari ini": deadline semua job aktif, diurutkan dari yang paling mendesak. Tanpa `status` = OVERDUE, CRITICAL, MISSING_DATA, WARNING. |
| `GET /alarms?owner=DOCS&kind=OVERDUE&acknowledged=false` | Riwayat alarm yang sudah terkirim (log-only atau lewat webhook). Ini cara ops melihat alarm kalau belum ada kanal eksternal. |
| `POST /alarms/:key/ack` | Tandai alarm sudah ditindaklanjuti. Idempoten — acknowledge kedua tidak menimpa yang pertama. |
| `GET /health` | 200/503. Mengecek koneksi database **dan** apakah scheduler alarm masih berjalan. |

Setiap perubahan tercatat di `audit_log` beserta fingerprint API key pemanggil.

## Alarm

**Tidak butuh n8n.** Secara default (`ALARM_WEBHOOK_URL` kosong) alarm cuma ditulis ke log proses lewat `LogNotifier` (`src/alarms/log-notifier.ts`) — tapi tetap **lengkap tercatat** di tabel `deadline_alarm_sent`, jadi tidak hilang. Pantau lewat `GET /alarms`, atau tambahkan kanal (Slack/WhatsApp/email/n8n/dst.) kapan pun siap.

- Scheduler berjalan di dalam proses API tiap `ALARM_TICK_SECONDS`. Kalau ada beberapa instance, hanya satu yang bekerja per tick (PostgreSQL advisory lock). Setiap alarm juga diklaim dulu di `deadline_alarm_sent` sebelum dikirim, jadi tidak ada alarm dobel.
- Pengiriman gagal (kanal eksternal mati atau error) → klaim dilepas, lalu dicoba lagi di tick berikutnya.
- Override rule tanpa deploy: tambah baris ke tabel `deadline_rule`. `active=false` menonaktifkan rule. `definition` berbentuk JSON `DeadlineRule` dan menimpa rule default dengan `code` yang sama. Baris yang tidak valid diabaikan dan dicatat di log.

### Menambahkan kanal eksternal nanti

Dua opsi, tanpa mengubah logika alarm sama sekali:

1. **Webhook generik** (paling cepat): isi `ALARM_WEBHOOK_URL` + `ALARM_WEBHOOK_SECRET` di `.env`. Tiap alarm di-POST sebagai JSON ke URL itu, ditandatangani HMAC. Bisa diarahkan ke n8n, Slack Incoming Webhook, atau endpoint kustom apa pun yang bisa memverifikasi tanda tangan (lihat "Verifikasi tanda tangan" di bawah).
2. **Notifier langsung** (tanpa hop tambahan): implementasikan `Notifier` (satu method: `send(alarm, shipment)`) di `src/alarms/`, misalnya `SlackNotifier` yang manggil Slack Web API, atau `WhatsAppCloudNotifier` yang manggil Meta Graph API langsung. Pasang di `alarms.module.ts` (ganti `useFactory` di provider `ALARM_NOTIFIER`). `formatAlarmMessage(alarm, shipment)` dari `@ff/deadline-alarm` sudah menyiapkan teksnya, dan `shipment.pic[owner]` (mis. `wa:+62...`) sudah menyimpan tujuan per fungsi (DOCS/CUSTOMS/OPS/FINANCE).

### Verifikasi tanda tangan webhook

Setiap request ke `ALARM_WEBHOOK_URL` membawa header `x-ff-timestamp` dan `x-ff-signature`. Contoh verifikasi di n8n: aktifkan opsi **Raw Body** di node Webhook, lalu tambahkan node Code ("Run Once for All Items") tepat sesudahnya. `getBinaryDataBuffer` juga berfungsi di mode binary `filesystem`. Uji dulu snippet ini di versi n8n yang Anda pakai — logika yang sama berlaku untuk penerima webhook lain, bukan hanya n8n.

```js
const crypto = require('crypto');
const secret = $env.ALARM_WEBHOOK_SECRET;
const { headers } = $input.first().json;
const raw = (await this.helpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
const ts = Number(headers['x-ff-timestamp']);
if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) throw new Error('timestamp kedaluwarsa');
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
const given = String(headers['x-ff-signature'] ?? '');
if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
  throw new Error('signature tidak valid');
}
return [{ json: JSON.parse(raw) }];   // { key, kind, severity, escalate, recipient, text, shipment, deadline }
```

Setelah itu, teruskan `text` ke `recipient` (WhatsApp/Slack). Kalau `escalate = true`, kirim juga ke supervisor.

## Deploy

- Image: `docker build -f apps/api/Dockerfile -t ff-api .` (dari root repo).
- Jalankan migrasi sebagai langkah deploy terpisah (`node dist/src/db/migrate-cli.js`, lihat service `migrate` di `docker-compose.yml`) sebelum instance baru dinyalakan. Aman dijalankan paralel.
- Di production, `API_KEYS` (≥ 24 karakter per key) wajib diisi. `ALARM_WEBHOOK_URL` opsional — bisa dikosongkan (alarm log-only), tapi kalau diisi, `ALARM_WEBHOOK_SECRET` (≥ 32 karakter) ikut wajib.
- Arahkan uptime monitor ke `/health`. Status 503 karena "scheduler alarm tidak berjalan" berarti alarm berhenti terkirim — ini berlaku sama meski alarm cuma log-only.

## Belum ada (sengaja, untuk tahap berikutnya)

- Login pengguna (SSO/OIDC) + RBAC. API key ini hanya untuk sistem-ke-sistem dan masa pilot.
- UI web.
- Integrasi CEISA (BC 1.1 / 2.0 / 3.0), tabel `customs_doc`, job costing.
- Endpoint admin untuk `deadline_rule`. Saat ini dikelola lewat SQL.
