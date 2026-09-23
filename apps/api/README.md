# @ff/api

Core API (NestJS 12 + PostgreSQL) untuk job forwarding, milestone, tracking DCSA, dan scheduler alarm deadline dari `@ff/deadline-alarm`.

## Menjalankan lokal

```bash
# dari root repo
npm ci
cp .env.example .env                      # isi API_KEYS (openssl rand -hex 24)
docker compose up -d db                   # atau PostgreSQL 16 lokal
npm run build
DATABASE_URL=postgres://ff:ff@localhost:5432/ff npm run migrate -w @ff/api
set -a && . ./.env && set +a && npm start -w @ff/api
```

Test e2e memakai database sungguhan dan **menghapus seluruh isi schema `public`** di database test:

```bash
TEST_DATABASE_URL=postgres://ff:ff@localhost:5432/ff_test npm test -w @ff/api
```

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
| `GET /health` | 200/503. Mengecek koneksi database **dan** apakah scheduler alarm masih berjalan. |

Setiap perubahan tercatat di `audit_log` beserta fingerprint API key pemanggil.

## Alarm

- Scheduler berjalan di dalam proses API tiap `ALARM_TICK_SECONDS`. Kalau ada beberapa instance, hanya satu yang bekerja per tick (PostgreSQL advisory lock). Setiap alarm juga diklaim dulu di `deadline_alarm_sent` sebelum dikirim, jadi tidak ada alarm dobel.
- Webhook gagal (n8n mati atau error) → klaim dilepas, lalu dicoba lagi di tick berikutnya.
- Override rule tanpa deploy: tambah baris ke tabel `deadline_rule`. `active=false` menonaktifkan rule. `definition` berbentuk JSON `DeadlineRule` dan menimpa rule default dengan `code` yang sama. Baris yang tidak valid diabaikan dan dicatat di log.

### Verifikasi tanda tangan di n8n

Setiap request ke `N8N_ALARM_WEBHOOK_URL` membawa header `x-ff-timestamp` dan `x-ff-signature`. Di n8n, aktifkan opsi **Raw Body** di node Webhook, lalu tambahkan node Code ("Run Once for All Items") tepat sesudahnya. `getBinaryDataBuffer` juga berfungsi di mode binary `filesystem`. Uji dulu snippet ini di versi n8n yang Anda pakai.

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
- Di production, config wajib: `N8N_ALARM_WEBHOOK_URL` + `ALARM_WEBHOOK_SECRET` (≥ 32 karakter), dan `API_KEYS` (≥ 24 karakter per key). Kalau tidak lengkap, aplikasi menolak start.
- Arahkan uptime monitor ke `/health`. Status 503 karena "scheduler alarm tidak berjalan" berarti alarm berhenti terkirim.

## Belum ada (sengaja, untuk tahap berikutnya)

- Login pengguna (SSO/OIDC) + RBAC. API key ini hanya untuk sistem-ke-sistem dan masa pilot.
- UI web.
- Integrasi CEISA (BC 1.1 / 2.0 / 3.0), tabel `customs_doc`, job costing.
- Endpoint admin untuk `deadline_rule`. Saat ini dikelola lewat SQL.
