# Menjalankan & mengembangkan di Windows (`D:\WebApp Forwarding`)

## 1. Sekali saja: pasang tools

| Tool | Catatan |
|------|---------|
| [Git for Windows](https://git-scm.com/download/win) | |
| [Node.js 22 LTS](https://nodejs.org) | versi ≥ 22.18 |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | untuk PostgreSQL. **Alternatif:** installer [PostgreSQL 16](https://www.postgresql.org/download/windows/) lalu pakai `-NoDocker` |

## 2. Ambil kode

PowerShell:

```powershell
git clone https://github.com/cupitebet/Freight-Forwarding-Web-App.git "D:\WebApp Forwarding"
cd "D:\WebApp Forwarding"
git checkout claude/modest-hamilton-fi90cx   # sampai PR #1 di-merge ke main
```

Kalau folder `D:\WebApp Forwarding` sudah berisi file lain, clone ke subfolder (mis. `D:\WebApp Forwarding\app`) supaya file lama tidak bercampur.

## 3. Setup + test (satu perintah)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1 -Test
```

Script ini akan:
1. Mengecek versi Node.js.
2. Membuat `.env` dengan **API key acak**. Key ditampilkan sekali saja, jadi simpan.
3. Menyalakan PostgreSQL (Docker) beserta database `ff` dan `ff_test`.
4. Menjalankan `npm ci`, build, dan migrasi.
5. Menjalankan seluruh test.

Kalau memakai PostgreSQL dari installer Windows, tambahkan `-NoDocker`. Script akan menampilkan perintah SQL untuk membuat user dan database.

Kalau port 5432 sudah dipakai program lain: jalankan `$env:DB_PORT=5433` sebelum script, lalu ubah port di `DATABASE_URL`/`TEST_DATABASE_URL` pada `.env`.

## 4. Jalankan & coba aplikasinya

Jendela PowerShell 1:

```powershell
npm start
```

Jendela PowerShell 2:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
```

Smoke test membuat job ekspor contoh, lalu menampilkan deadline-nya (SI closing CRITICAL, VGM ESTIMASI, dan seterusnya). Setelah itu smoke test mencatat milestone, mengubah cut-off, menampilkan layar "Hari ini" PIC DOCS, dan terakhir menutup job contoh. Alarm muncul di jendela `npm start` pada tick scheduler berikutnya (default 5 menit; set `ALARM_TICK_SECONDS=30` di `.env` supaya lebih cepat saat mencoba).

Coba manual:

```powershell
$h = @{ 'x-api-key' = '<API key dari .env>' }
Invoke-RestMethod http://localhost:3000/deadlines -Headers $h | Format-Table
```

## 5. Upgrade ke versi terbaru

```powershell
cd "D:\WebApp Forwarding"
git pull
powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1 -Test
```

Script aman dijalankan berulang: `.env` dan data tidak disentuh, dan hanya migrasi baru yang diterapkan.

## 6. Mengembangkan bersama Claude dari folder ini

Sesi Claude di cloud tidak bisa mengakses drive `D:`. Untuk bekerja langsung di folder ini, pilih salah satu:
- Buka folder `D:\WebApp Forwarding` di **Claude Desktop app** (Claude Code).
- Atau di terminal: `cd "D:\WebApp Forwarding"` lalu `claude remote-control`. Sesinya akan muncul di aplikasi Claude Code.

Dengan begitu Claude bisa build, test, dan menjalankan aplikasi langsung di komputer Anda.
