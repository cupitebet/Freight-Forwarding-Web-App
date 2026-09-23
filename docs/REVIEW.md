# Review Blueprint "Freight Forwarder App & API Bea Cukai"

Catatan: repo ini belum punya kode aplikasi. Yang direview adalah dokumen
`Freight Forwarder App & API Bea Cukai.docx` (arsitektur NestJS + n8n + PostgreSQL + Redis, integrasi H2H CEISA 4.0).

Arahnya sudah benar: core app dipisah dari lapisan integrasi, PostgreSQL + JSONB, token disimpan di cache, dan layar utama fokus ke pengecualian (exception).
Di bawah ini daftar yang perlu diperbaiki sebelum mulai coding, diurutkan dari yang paling berisiko.

## 1. Temuan penting (perbaiki sebelum build)

| # | Temuan | Risiko | Rekomendasi |
|---|--------|--------|-------------|
| 1 | **Retry POST dokumen pada 500/timeout tidak idempoten.** Blueprint menyarankan retry dengan backoff 2/5/10 detik. | Kalau request pertama sebenarnya sudah diterima CEISA tapi responsnya timeout, dokumen bisa terkirim dua kali atau ditolak sebagai duplikat. | Sebelum retry, cek dulu status berdasarkan `nomorAju`. Pakai antrian dengan backoff lebih panjang (menit, bukan detik) dan dead-letter queue. Kalau retry habis, kirim alarm ke manusia. |
| 2 | **`nomorAju` digenerate dengan Redis `INCR`.** | Redis bukan penyimpanan yang tahan lama. Setelah restart atau failover, counter bisa mundur dan menghasilkan nomor duplikat. | Pakai PostgreSQL (tabel counter per tanggal + `SELECT … FOR UPDATE`, atau sequence). Nomor dikunci saat draft dibuat, bukan saat submit. |
| 3 | **Format `nomorAju` di tabel tidak konsisten.** Tertulis "4 digit Kode Kantor", padahal contoh `kodeKantor` di dokumen yang sama adalah `040300` (6 digit). | Semua submit bisa ditolak. | Cocokkan dengan spesifikasi resmi PIA-CEISA40 dan tulis unit test untuk generatornya. |
| 4 | **Logika kepabeanan inti (mapping + validasi) ditaruh di n8n.** | Flow visual sulit di-code-review, di-unit-test, dan di-versioning. Padahal justru aturan ini yang paling sering berubah dan paling mahal kalau salah. | Taruh schema JSON, mapping, dan validasi (Σ CIF barang = CIF header, seri barang berurutan, HS code) di package TypeScript yang di-versioning dan dites. Package ini dipakai bersama oleh NestJS dan n8n. Gunakan n8n untuk "lem": notifikasi, polling, OCR. Export workflow n8n ke git. |
| 5 | **Angka pakai tipe `Number`** (bruto/netto 4 desimal, CIF 2 desimal). | Floating point JS membuat penjumlahan CIF meleset dari header, lalu ditolak CEISA. | Gunakan `numeric(18,4)` di PostgreSQL dan library desimal (mis. `decimal.js`) di kode. Pembulatan hanya dilakukan di layer mapping. |
| 6 | **Refresh token tanpa lock.** | Kalau banyak worker menemukan token kedaluwarsa bersamaan, semuanya refresh sekaligus (stampede). Bisa kena rate limit atau saling menimpa token. | Pakai single-flight: `SET ceisa_token_lock NX PX 10000`, worker lain menunggu. Simpan username/password portal di secret manager, jangan di credential n8n biasa. |
| 7 | **Webhook n8n ↔ NestJS belum ada otentikasi.** | Siapa pun yang tahu URL-nya bisa memicu submit ke Bea Cukai. | Pakai HMAC signature + timestamp di kedua arah. n8n hanya bisa diakses dari jaringan privat. |
| 8 | **Data eksekusi n8n menyimpan payload lengkap** (NPWP/NIB, nilai barang). | Terkait UU PDP. | Set `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`, aktifkan pruning, dan simpan audit trail di PostgreSQL (request/response + hash) dengan kebijakan retensi yang jelas. |
| 9 | **Belum ada modul deadline / cut-off sama sekali.** | Keterlambatan SI/VGM/CY closing berujung shut-out atau roll-over. Manifes telat berujung sanksi. Free time lewat berujung demurrage/storage. | **Sudah dibuat di branch ini**: `packages/deadline-alarm` (lihat bagian 2). |
| 10 | **Cakupan dokumen masih condong ke impor (BC 2.0).** | Alur ekspor (PEB/BC 3.0 sampai NPE), perbaikan atau pembatalan pos BC 1.1, dan dokumen LARTAS belum dibahas. | Tambahkan ke backlog fase 2. |

Catatan kecil:
- Timezone: pelabuhan di WITA/WIT (Makassar, Bitung, Sorong). Simpan semua waktu sebagai `timestamptz`, dan tampilkan dalam zona waktu pelabuhan.
- Polling status tiap 15 menit sebaiknya hanya untuk dokumen yang masih aktif (belum SPPB/NPE), supaya tidak menghabiskan kuota API.
- Klaim "n8n 5x lebih cepat" di tabel perbandingan tidak punya sumber. Sebaiknya dihapus dari dokumen yang dibaca manajemen.

## 2. Alarm cut-off & deadline (sudah diimplementasikan)

Lokasi: `packages/deadline-alarm`. Cara pakai ada di README package tersebut.

Deadline yang dipantau secara default:

| Kode | Deadline | PIC |
|------|----------|-----|
| `EXP_SI_CLOSING` | Closing Shipping Instruction ke pelayaran | DOCS |
| `EXP_VGM_CLOSING` | Closing VGM | DOCS |
| `EXP_PEB_NPE` | PEB harus sudah NPE sebelum CY closing | CUSTOMS |
| `EXP_CY_CLOSING` | CY closing (gate-in full container) | OPS |
| `EXP_DRAFT_BL` | Konfirmasi draft B/L | DOCS |
| `EXP_OUTWARD_MANIFEST` | Outward manifest BC 1.1 (NVOCC/agen) | DOCS |
| `IMP_RKSP` | RKSP (agen pelayaran) | DOCS |
| `IMP_INWARD_MANIFEST` | Inward manifest BC 1.1 / pos house B/L | DOCS |
| `IMP_PIB_PRENOTIF` | PIB sebelum kapal tiba (SLA internal) | CUSTOMS |
| `IMP_RED_LANE_INSPECTION` | Jalur merah, siapkan pemeriksaan fisik | OPS |
| `IMP_STORAGE_FREE_TIME` | Free time penumpukan terminal | OPS |
| `IMP_DEMURRAGE_FREE_TIME` | Free time demurrage | OPS |
| `IMP_DETENTION_FREE_TIME` | Free time detention (empty return) | OPS |
| `IMP_BTD_LIMIT` | Batas Barang Tidak Dikuasai (30 hari di TPS) | CUSTOMS |

Perilaku alarm:
- Cut-off diambil dari booking confirmation pelayaran. Kalau belum diinput, deadline diestimasi dari ETD dan diberi label **ESTIMASI**.
- Reminder dikirim bertahap (mis. H-48 / H-24 / H-6 / H-2 jam). Shipment yang baru diinput mendekati deadline hanya menerima satu reminder paling relevan, tidak dibanjiri semua reminder.
- Kalau jadwal kapal atau cut-off berubah, reminder otomatis dijadwalkan ulang.
- Alarm terlambat diulang berkala. Alarm terlambat kedua dan seterusnya dieskalasi ke supervisor.
- Data yang kurang (mis. cut-off draft B/L belum diinput) juga memicu notifikasi ke PIC.
- Aman untuk banyak worker: tiap alarm "diklaim" dulu di tabel `deadline_alarm_sent` sebelum dikirim.

> ⚠️ Kolom `basis` di `src/rules.ts` (PMK 158/2017, PMK 145/2014, BTD 30 hari, dsb.) adalah titik awal.
> **Minta tim compliance memverifikasi setiap batas waktu sebelum dipakai di produksi.**
> Katalog rule dirancang untuk disimpan di tabel `deadline_rule`, sehingga bisa di-override per carrier atau per customer tanpa deploy ulang.

## 3. Insight tambahan

1. **Isi cut-off otomatis dari email pelayaran.** Booking confirmation dan pengumuman perubahan jadwal kapal datang lewat email atau PDF. Parsing dengan LLM atau OCR (lewat n8n), lalu isi `carrierCutoffs`/`etd`/`eta`. Alarm akan langsung akurat, bukan estimasi. Ini fitur dengan ROI tertinggi untuk modul alarm.
2. **Tampilan "Hari ini" per PIC.** Satu layar berisi deadline berstatus `CRITICAL`/`OVERDUE`/`MISSING_DATA` milik user tersebut, diurutkan berdasarkan `dueAt`. Ini implementasi konkret dari bagian 6.1 blueprint (Exception Management).
3. **Tombol "Acknowledge" di WhatsApp/Slack.** Kolom `acknowledged_by` sudah disiapkan di tabel. Alarm yang belum di-acknowledge dalam X menit dieskalasi.
4. **Metrik kepatuhan.** `DONE_LATE` per rule, per PIC, dan per carrier bisa jadi KPI bulanan, plus data untuk negosiasi free time dengan pelayaran.
5. **Kalkulator biaya demurrage/storage.** Dari free time + tarif, tampilkan estimasi biaya harian di notifikasi. "Lewat 9 jam" kurang menekan dibanding "biaya berjalan Rp 1,2 jt/hari".

## 4. Apakah bisa mengambil dari `msitarzewski/agency-agents`?

**Singkatnya: tidak bisa dipakai untuk merombak aplikasi, tapi bisa membantu proses development.**

- Isi repo tersebut adalah ±300 file markdown berisi *persona/prompt* untuk AI coding assistant (Claude Code subagents, Cursor, dll.), lisensi MIT. **Tidak ada kode aplikasi** yang bisa dipakai, dan tidak ada agen yang spesifik untuk freight forwarding, kepabeanan, atau CEISA (`supply-chain-strategist` fokus ke procurement di China).
- Yang berguna untuk tim ini adalah menyalin beberapa agen ke `.claude/agents/` sebagai reviewer atau asisten saat membangun aplikasi:
  - `specialized/specialized-workflow-architect.md`: memetakan state machine shipment dan dokumen pabean (happy path + semua failure mode). Paling relevan untuk alur submit CEISA.
  - `engineering/engineering-backend-architect.md`, `testing/testing-api-tester.md`: untuk desain NestJS dan pengujian integrasi H2H.
  - `specialized/data-privacy-officer.md`, `security/security-compliance-auditor.md`: review UU PDP / PSE / ISO 27001.
  - `engineering/engineering-devops-automator.md`, `engineering/engineering-sre.md`: deployment n8n queue mode dan monitoring.
- Lebih bernilai lagi: gunakan format mereka untuk membuat **agen domain sendiri**, misalnya "CEISA Compliance Reviewer" (memeriksa mapping BC 2.0/BC 1.1 terhadap spesifikasi PIA-CEISA40) dan "Freight Ops Deadline Planner". Pengetahuan domain inilah yang tidak ada di repo tersebut.
