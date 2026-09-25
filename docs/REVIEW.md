# Review Blueprint "Freight Forwarder App & API Bea Cukai"

Review dokumen `Freight Forwarder App & API Bea Cukai.docx` (arsitektur NestJS + n8n + PostgreSQL + Redis, integrasi H2H CEISA 4.0).
Saat review ini dimulai repo belum punya kode. Implementasinya sekarang ada di `apps/api` dan `packages/deadline-alarm`.

> **Keputusan scope (23/09/2026):** aplikasi hanya untuk **internal** perusahaan.
> Portal pelanggan (blueprint bagian 3.1 "Customer Portal" & 6.3 "Portal Pelanggan Mandiri") **tidak dibangun**,
> dan pendaftaran PSE Komdigi tidak diperlukan. Pengguna: staf DOCS, CUSTOMS, OPS, FINANCE.
>
> **Keputusan arsitektur (25/09/2026): n8n dikeluarkan dari jalur wajib.** Blueprint asli memakai n8n
> sebagai perantara notifikasi (bagian 5). Sekarang `apps/api` mengirim alarm langsung: log-only
> secara default (`LogNotifier`, dibaca lewat `GET /alarms`), dan kanal eksternal (webhook generik,
> atau `Notifier` kustom seperti Slack/WhatsApp Cloud API) ditambahkan kapan pun siap tanpa n8n.
> Lihat `apps/api/README.md` bagian Alarm. n8n tetap bisa dipakai sebagai salah satu kanal (lewat
> `ALARM_WEBHOOK_URL`), tapi bukan lagi komponen yang harus ada.

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
| `EXP_PEB_NPE` | PEB harus sudah NPE sebelum CY closing (PMK 155/2022) | CUSTOMS |
| `EXP_PEB_BL_UPDATE` | Lengkapi MBL/HBL di PEB ≤ 3 hari setelah berangkat (PMK 155/2022) | CUSTOMS |
| `EXP_CY_CLOSING` | CY closing (gate-in full container) | OPS |
| `EXP_DRAFT_BL` | Konfirmasi draft B/L | DOCS |
| `EXP_OUTWARD_MANIFEST` | Outward manifest BC 1.1, **sebelum** keberangkatan (PMK 97/2020) | DOCS |
| `IMP_RKSP` | RKSP (agen pelayaran) | DOCS |
| `IMP_INWARD_MANIFEST` | Inward manifest laut: pelayaran ≥ 24 jam → **24 jam sebelum tiba**; < 24 jam → sebelum tiba | DOCS |
| `IMP_INWARD_MANIFEST_AIR` | Inward manifest udara: sebelum tiba | DOCS |
| `IMP_HOUSE_BL_RECONCILE` | Rekonsiliasi house B/L ↔ master B/L ≤ 7 hari setelah tiba (kode 57) | DOCS |
| `IMP_PIB_PRENOTIF` | PIB sebelum kapal tiba (SLA internal) | CUSTOMS |
| `IMP_RED_LANE_INSPECTION` | Jalur merah, siapkan pemeriksaan fisik | OPS |
| `IMP_STORAGE_FREE_TIME` | Free time penumpukan terminal | OPS |
| `IMP_DEMURRAGE_FREE_TIME` | Free time demurrage | OPS |
| `IMP_DETENTION_FREE_TIME` | Free time detention (empty return) | OPS |
| `IMP_BTD_LIMIT` | Batas Barang Tidak Dikuasai (30 hari di TPS), pengingat H-15/H-7/H-3 | CUSTOMS |

Perilaku alarm:
- Cut-off diambil dari booking confirmation pelayaran. Kalau belum diinput, deadline diestimasi dari ETD dan diberi label **ESTIMASI**.
- Reminder dikirim bertahap (mis. H-48 / H-24 / H-6 / H-2 jam). Shipment yang baru diinput mendekati deadline hanya menerima satu reminder paling relevan, tidak dibanjiri semua reminder.
- Kalau jadwal kapal atau cut-off berubah, reminder otomatis dijadwalkan ulang.
- Alarm terlambat diulang berkala. Alarm terlambat kedua dan seterusnya dieskalasi ke supervisor.
- Data yang kurang (mis. cut-off draft B/L belum diinput) juga memicu notifikasi ke PIC.
- Aman untuk banyak worker: tiap alarm "diklaim" dulu di tabel `deadline_alarm_sent` sebelum dikirim.

> ⚠️ Kolom `basis` di `src/rules.ts` sudah diperbarui mengikuti riset regulasi (bagian 7), tetapi masih berasal dari sumber sekunder.
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

## 5. Evaluasi repo logistik open-source lain

Dicek 23/09/2026 (kode, lisensi, commit terakhir).

| Repo | Isi sebenarnya | Lisensi | Cocok untuk kita? |
|------|----------------|---------|-------------------|
| [fleetbase/fleetbase](https://github.com/fleetbase/fleetbase) | Platform operasional **armada darat**: order, driver, kendaraan, geofence, rute, telematika, invoice. Stack Laravel (PHP) + Ember.js. Aktif dikembangkan. | **AGPL-3.0** / komersial | **Bukan pengganti core app.** Tabel `manifests` di sana adalah manifest rute driver, bukan manifes BC 1.1. Tidak ada konsep vessel, B/L, container, cut-off, atau kepabeanan. Stack-nya juga beda dari blueprint (NestJS/React). Bisa dipertimbangkan nanti **khusus untuk trucking** (antar container ke/dari pelabuhan) sebagai sistem terpisah lewat REST API/webhook. Perhatikan AGPL: kalau Fleetbase dimodifikasi lalu dipakai customer lewat jaringan, modifikasinya wajib dibuka, kecuali membeli lisensi komersial. |
| [themixlyweb/nextjs-logistics-website-template](https://github.com/themixlyweb/nextjs-logistics-website-template) | Landing page / company profile statis: hero, about, facts, footer. Next.js 15 + Bootstrap. Tanpa backend, tanpa fitur aplikasi. | MIT | Hanya untuk **website marketing** perusahaan. Tidak ada yang bisa dipakai untuk aplikasi operasional. |
| [vinaybhosle/shippingrates-mcp](https://github.com/vinaybhosle/shippingrates-mcp) | Wrapper MCP untuk SaaS berbayar (tarif D&D, local charge, freight rate, jadwal kapal) untuk 6 carrier besar. Dibayar per panggilan (USDC). Data lebih banyak di pelabuhan India, **tidak ada data pelabuhan Indonesia** di README. | MIT (kode wrapper saja; datanya milik SaaS) | Belum cocok. Bisa dicoba untuk tim sales/pricing lewat Claude, tapi cek dulu cakupan pelabuhan Indonesia. |
| [lxxmng/container-tracking-mcp](https://github.com/lxxmng/container-tracking-mcp) | Wrapper MCP (±360 baris) untuk SaaS tracking container, 200+ carrier termasuk KMTC/PIL/SITC. Event **dinormalkan ke standar DCSA**, plus ETA, posisi AIS, dan countdown D&D. Bayar per token (mulai €49). | MIT (wrapper) | **Paling berguna, tapi dari sisi idenya, bukan kodenya.** Kita tidak perlu MCP-nya di aplikasi; kita butuh **API tracking yang output-nya DCSA** (dari provider ini, provider lain, atau API carrier langsung). Karena itu sudah dibuat `applyDcsaEvents()` (lihat di bawah). |

### Yang sudah diambil: adapter DCSA → alarm

`packages/deadline-alarm/src/dcsa.ts`: `applyDcsaEvents(shipment, events)` mengubah event DCSA Track & Trace menjadi data shipment:

- `DEPA`/`ARRI` di POL/POD → `atd`/`ata` (aktual) atau update `etd`/`eta` (estimasi). Transshipment diabaikan.
- `DISC` laden di POD → `CONTAINER_DISCHARGED`, yang memulai hitungan free time storage/demurrage.
- `GTOT` laden → `CONTAINER_GATE_OUT`, yang menutup demurrage dan memulai detention. Baru terisi setelah **semua** container keluar.
- `GTIN` empty → `EMPTY_RETURNED`, yang menutup detention.
- Ekspor: `GTIN` laden di POL → `CONTAINER_GATE_IN`, yang menutup CY closing.
- Data yang diisi manual tidak ditimpa, dan hasilnya mengembalikan daftar `changes` untuk audit log.

Dengan ini, polling tracking (mis. tiap 1 jam lewat n8n) langsung menggeser deadline dan menghentikan alarm tanpa input manual. Contohnya: kapal delay membuat semua cut-off dijadwalkan ulang, dan container yang sudah gate-out menghentikan alarm demurrage.

**Rekomendasi:** pertahankan blueprint (NestJS + n8n + PostgreSQL). Jangan merombak ke Fleetbase. Beli data tracking via API berformat DCSA, dan pakai Fleetbase hanya kalau nanti butuh modul trucking/driver.

## 6. Evaluasi batch kedua (repo TMS & vendor)

Dicek 23/09/2026. Repo di-clone dan dibaca kodenya. Situs Shipday dan TMS Consulting diblokir proxy, jadi informasinya diambil dari hasil pencarian web.

| Sumber | Isi sebenarnya | Lisensi / status | Kesimpulan |
|--------|----------------|------------------|------------|
| [github.com/FreightForward](https://github.com/FreightForward) + [freightforward.github.io](https://freightforward.github.io/) | Organisasi milik Resgef Labs (Bangladesh). Isinya hanya 2 repo: situs intro dan dokumentasi (Jekyll). Kode aplikasinya ada di repo `anwar-gazi/freightforward`. | Tidak aktif sejak Juli 2021 | Hanya dokumentasi. Lihat baris berikut. |
| [anwar-gazi/freightforward](https://github.com/anwar-gazi/freightforward) | **Satu-satunya yang domainnya benar-benar forwarder.** Aplikasi Django untuk sea import/export dan air export: Job, MBL/HBL, MAWB/HAWB, cargo manifest, delivery order, job costing, credit note. | **GPL-2.0**, Django 2.1 + Python 3.6 (keduanya sudah EOL), commit terakhir 2021, hanya ada 7 file test | **Ambil konsep model datanya, jangan kodenya.** Kodenya copyleft dan stack-nya sudah mati. Desainnya juga menduplikasi model per modul (`SeaImportMbl`, `SeaExport…`, `Air…`), ETA hanya disimpan sebagai tanggal tanpa jam, dan tidak ada cut-off, free time, maupun kepabeanan. Hierarki Job → MBL → HBL → barang/container dan pemisahan job costing sudah dipakai di usulan model data di bawah. |
| [JoeCelaster/InterFrieght](https://github.com/JoeCelaster/InterFrieght) | Proyek capstone mahasiswa (Kalvium): login, upload 4 dokumen (LC, packing list, invoice, PO), dan tracking ID. Stack Express + MongoDB + React. | **Tanpa lisensi** (artinya tidak boleh dipakai ulang), tanpa test | Tidak berguna. Model shipment-nya hanya berisi nama user dan path file. Nama file upload ditentukan dari `Date.now()` dan disimpan di disk lokal. |
| [Topic transport-management-system](https://github.com/topics/transport-management-system?o=desc&s=stars) | 14 repo. Yang terbesar Fleetbase (sudah dievaluasi di bagian 5). Sisanya sistem bus sekolah/kampus, tiket, tanker, dan proyek kuliah dengan 0–22 bintang. | – | Tidak ada yang relevan untuk forwarding laut/udara maupun kepabeanan. |
| [Topic transportation-management-system](https://github.com/topics/transportation-management-system) | 13 repo. Hanya dua yang serius: **Trenova** dan **loadpartner/tms**. Sisanya berupa stub API atau daftar tautan. | – | Lihat dua baris berikut. |
| [emoss08/Trenova](https://github.com/emoss08/Trenova) | TMS **trucking AS** yang matang: dispatch, rating, billing, akuntansi, EDI 204/214, FMCSA, ekstraksi dokumen. Stack Go + PostgreSQL + React 19, dengan CDC ke Meilisearch/Redis. Aktif (commit kemarin). | **FSL-1.1** (source-available, bukan open source). Dilarang dipakai untuk produk yang bersaing; baru menjadi Apache-2.0 dua tahun setelah setiap rilis. | **Bagus sebagai referensi arsitektur**, bukan untuk dipakai langsung. Domainnya trucking AS (FMCSA, EDI X12), bukan laut/pabean. Yang layak dipelajari: package `shared/money` dan `decimalutils` (sesuai temuan #5 soal desimal), migrasi SQL-first, audit trail, dan pipeline ekstraksi dokumen. |
| [loadpartner/tms](https://github.com/loadpartner/tms) | TMS untuk **freight broker truk di AS**: shipment, carrier, check call, dokumen. Stack Laravel + Inertia + React. | **FCL-1.0** (source-available), terakhir aktif Okt 2025 | Tidak cocok: domain dan stack-nya berbeda, dan pengembangannya melambat. |
| [Shipday](https://www.shipday.com/pricing) | SaaS **last-mile delivery** untuk restoran, retail, dan e-commerce: dispatch driver, GPS, ETA pelanggan. Gratis sampai 300 order/bulan, berbayar $39–$299/bulan ([Capterra](https://www.capterra.com/p/211323/Shipday/)). | Komersial | Tidak relevan untuk forwarding. Pertimbangkan hanya kalau nanti ada layanan antar dokumen atau barang ke customer. |
| [TMS Consulting](https://tms-consulting.co.id/) | **Bukan software TMS.** "TMS" adalah nama perusahaan: SAP Gold Partner di Jakarta yang menjual implementasi SAP S/4HANA Cloud Public Edition (GROW with SAP) untuk UKM ([SAP](https://www.sap.com/assetdetail/2024/04/b20fc599-b57e-0010-bca6-c68f7e60039b.html)). | Komersial | Alternatif "beli ERP". SAP kuat di akuntansi dan pajak, tapi tidak punya modul forwarding (MBL/HBL, cut-off) maupun H2H CEISA bawaan, jadi tetap butuh kustomisasi. Relevan kalau perusahaan juga butuh ERP keuangan. Aplikasi kita bisa mengirim invoice/jurnal ke SAP lewat API, alih-alih membangun modul akuntansi penuh. |

### Usulan model data inti (konsep dari anwar-gazi/freightforward, disesuaikan)

Satu model untuk semua moda dan arah (bukan tabel terpisah per sea import/export/air):

```
Job (nomor job, arah: EXPORT/IMPORT, moda: SEA/AIR, customer, PIC per fungsi)
 ├─ MasterDoc   (MBL / MAWB: carrier, vessel/flight, voyage, POL/POD UN/LOCODE,
 │               ETD/ATD/ETA/ATA timestamptz, carrier cut-off SI/VGM/CY/DRAFT_BL)
 │   └─ HouseDoc (HBL / HAWB: shipper, consignee, notify; = pos manifes BC 1.1)
 │       └─ CargoLine (HS code, uraian, kemasan, bruto/netto numeric(18,4), nilai)
 ├─ Container   (nomor, ukuran/tipe, seal, VGM, free time D&D; relasi ke HouseDoc)
 ├─ CustomsDoc  (BC 1.1 / BC 2.0 / BC 3.0: nomorAju, nomorDaftar, status CEISA, jalur,
 │               payload request/response JSONB untuk audit)
 ├─ Milestone   (event: SI_SUBMITTED, NPE_ISSUED, CONTAINER_GATE_OUT, … + sumber: manual/CEISA/DCSA)
 ├─ Document    (file di S3/MinIO: invoice, packing list, SPPB, NPE, DO)
 └─ JobCost / JobRevenue (per charge type & mata uang → profit per job; ekspor ke ERP)
```

`Milestone` + `MasterDoc`/`Container` adalah sumber data untuk `packages/deadline-alarm`. Datanya diisi dari input manual, respon CEISA, dan tracking DCSA.

### Kesimpulan batch ini

Tidak ada repo yang bisa langsung dipakai sebagai dasar aplikasi forwarding dengan kepabeanan Indonesia. Jadi keputusan membangun sendiri sesuai blueprint tetap benar. Yang diambil hanya konsep dan referensi: model data dari anwar-gazi/freightforward, pola arsitektur dari Trenova, dan opsi integrasi ke SAP untuk sisi keuangan.

## 7. Evaluasi dokumen "Riset Aplikasi Freight Forwarding" (PDF, 14 halaman)

Riset ini ditulis berdasarkan kondisi repo **sebelum** PR #1. Beberapa kekurangan yang disebut di dalamnya sudah dibangun: PostgreSQL, scheduler, HMAC, CI, dan monitoring scheduler lewat `/health`. Nilai utamanya ada di batas waktu regulasi yang lebih spesifik, dan sebagian menunjukkan rule lama saya salah.

### Diadopsi ke katalog rule

| Temuan riset | Sebelumnya | Sekarang |
|---|---|---|
| Inward manifest laut: pelayaran ≥ 24 jam → paling lambat 24 jam sebelum kedatangan; < 24 jam → sebelum kedatangan (PMK 158/2017 jo. 97/2020) | Saat kedatangan (**terlambat 24 jam** untuk pelayaran panjang) | Anchor baru `ARRIVAL_BY_VOYAGE`. Jika ETD asal belum diisi, sistem mengasumsikan pelayaran panjang (batas lebih awal = lebih aman) dan menandai deadline sebagai estimasi. |
| Inward manifest udara: sebelum kedatangan | Sama, tapi digabung dengan laut | Rule terpisah `IMP_INWARD_MANIFEST_AIR` |
| Outward manifest: sebelum keberangkatan | ATD + 24 jam (**terlalu longgar**) | ATD/ETD + 0, laut & udara |
| Eskalasi H-12 jam untuk inward manifest | – | Ditambahkan ke pengingat |
| Denda manifes Rp10–100 jt (terlambat), berjenjang bila berulang | – | Kolom `risk` baru, tampil di notifikasi |
| PMK 155/2022: data B/L di PEB ≤ 3 hari kalender setelah berangkat, ingatkan hari ke-2 | – | Rule baru `EXP_PEB_BL_UPDATE` + milestone `PEB_BL_UPDATED` |
| PEB paling lambat sebelum barang masuk Kawasan Pabean | Dasar hukum PMK 145/2014 | Dasar hukum diganti PMK 155/2022 |
| House B/L ditolak (kode 57) jika tidak terekonsiliasi dengan master B/L dalam 7 hari; peringatan hari ke-5 | – | Rule baru `IMP_HOUSE_BL_RECONCILE` + milestone `HOUSE_BL_RECONCILED` |
| BTD 30 hari: peringatan H-15, H-7, H-3 | H-7, H-3, H-1 | H-15, H-7, H-3, H-1 |

Selain itu, notifikasi estimasi sekarang menyebut alasannya secara spesifik (mis. "carrierCutoffs.VGM belum diisi"). Sebelumnya selalu tertulis "cut-off pelayaran belum diinput", padahal tidak selalu itu penyebabnya.

### Masih perlu verifikasi (jangan dianggap final)

- **Sumber riset sebagian besar sekunder** (FAQ, blog konsultan, Scribd, portal peraturan pihak ketiga). Kode 57 / 7 hari hanya bersumber dari FAQ Duktek di Scribd, jadi wajib dikonfirmasi ke KPU/KPPBC setempat.
- **Tabel manifes di PDF rusak saat konversi.** Tanda ≥/< hilang, dan baris "tidak sandar/bongkar 24 jam (laut)/8 jam (udara), manifes nihil" tidak bisa dibaca utuh. Kewajiban manifes nihil belum dimodelkan.
- **Dasar BTD.** Riset menyebut "semangat PMK 145/2014". Angka 30 hari sesuai UU Kepabeanan ps. 68, tapi teks PMK yang berlaku saat ini perlu dicek.
- **Batas pembatalan PEB (3 hari kerja).** Belum dimodelkan karena perlu kalender hari libur nasional.

### Tidak diikuti, dengan alasan

| Rekomendasi riset | Keputusan | Alasan |
|---|---|---|
| BullMQ + Redis `upsertJobScheduler` untuk tick alarm | **Belum perlu** | Masalah yang mau diselesaikan riset (eksekusi tumpang tindih di banyak server, pengiriman ganda) sudah teratasi dengan PostgreSQL advisory lock + klaim idempoten per alarm, dan sudah diuji dengan tick paralel. BullMQ menambah Redis sebagai komponen kritis. BullMQ baru layak dipakai untuk **antrian submit CEISA** (retry/backoff per dokumen, temuan #1). |
| Idempotency key `hash_shipment_ID_event_type` | Key sekarang lebih tepat | Key yang dipakai: `job:rule:dueAt:threshold`. Tiap tahap pengingat punya key sendiri, dan pengingat otomatis dijadwalkan ulang kalau jadwal berubah. Key per event_type akan mencegah pengingat kedua dan seterusnya. |
| ORM (TypeORM/MikroORM) dengan migrasi auto-generated | Tetap SQL + migrasi manual | Untuk data kepabeanan, migrasi yang ditulis dan di-review eksplisit lebih aman daripada auto-generate. Constraint (CHECK, UNIQUE, FK) terlihat jelas. Bisa ditinjau ulang kalau tim lebih nyaman dengan ORM. |
| Multi-tenancy **per schema** (`tenant_jkt`, `tenant_sby`) untuk cabang | **Tidak disarankan** untuk cabang satu perusahaan | Cabang satu perusahaan berbagi customer, vendor, dan laporan konsolidasi. Schema terpisah membuat migrasi berlipat dan laporan lintas cabang sulit. Cukup kolom `branch_id` + Row-Level Security PostgreSQL. Schema-per-tenant baru relevan kalau aplikasi dijual sebagai SaaS ke perusahaan lain. |
| Tabel `alarm_states` (Pending/Triggered/Escalated/Resolved) | Sudah tercakup | `deadline_alarm_sent` (terkirim + acknowledge) plus status deadline yang dihitung dari milestone (`DONE`/`OVERDUE`). Status tidak disimpan ganda supaya tidak bisa tidak sinkron. |
| **Evolution API** untuk WhatsApp | **Hati-hati: jangan untuk produksi** | Evolution API memakai WhatsApp Web tidak resmi (scan QR). Nomor bisa diblokir Meta, dan cara ini melanggar ketentuan WhatsApp. Alarm kepatuhan tidak boleh bergantung pada kanal yang bisa mati tiba-tiba. Untuk produksi pakai **WhatsApp Business Platform (Cloud API) resmi** atau BSP resmi, dengan email/Slack sebagai kanal cadangan. Evolution API cukup untuk demo. |

### Diadopsi sebagai backlog (belum dikerjakan)

- **PSE Lingkup Privat Komdigi: tidak diperlukan untuk saat ini.** Keputusan pemilik (23/09/2026): aplikasi hanya dipakai internal, tidak melayani publik. Portal pelanggan (blueprint bagian 3.1 & 6.3) **dikeluarkan dari scope**. Tinjau ulang PSE hanya jika kelak ada akses dari luar perusahaan (mis. login untuk klien/agen).
- **Integrasi CEISA:** OAuth 2.0, validasi JSON Schema BC resmi dari `openapi.beacukai.go.id` sebelum submit, penanganan error 901/908 (sertifikat/koneksi) dengan backoff, dan **fallback ekspor flat file/Excel** untuk upload manual kalau H2H mati.
- **Referensi DCSA** `carrierBookingReference` dan `transportDocumentReference` disimpan di `master_doc` untuk mencocokkan feed tracking.
- **n8n (opsional, kalau nanti dipakai sebagai salah satu kanal):** pisahkan URL `/webhook-test/` (uji) dan `/webhook/` (produksi). Lihat keputusan arsitektur di atas — bukan lagi prasyarat.
- **Pilot:** shadow run 2–4 minggu berdampingan dengan spreadsheet manual sebelum tim sepenuhnya bergantung pada alarm. Ini sama dengan rekomendasi sebelumnya.
