<#
.SYNOPSIS
  Setup lingkungan lokal (Windows) untuk Freight Forwarding Web App.

.DESCRIPTION
  1. Cek Node.js >= 22.18
  2. Buat .env dari .env.example (API key dibuat acak) jika belum ada
  3. Nyalakan PostgreSQL lewat Docker Desktop (kecuali -NoDocker)
  4. npm ci, build, migrasi database
  5. Opsional: jalankan test (-Test) dan/atau start API (-Start)

  Aman dijalankan berulang kali (mis. setelah git pull untuk upgrade).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1 -Test -Start
#>
param(
  [switch]$NoDocker,  # pakai PostgreSQL yang sudah terpasang di Windows
  [switch]$Test,      # jalankan seluruh test setelah build
  [switch]$Start      # start API setelah selesai
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host ""; Write-Host "GAGAL: $msg" -ForegroundColor Red; exit 1 }
function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($argv -join ' ') (exit code $LASTEXITCODE)" }
}
function RandomHex([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

# ---------------------------------------------------------------- 1. Node.js
Step 'Cek Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js belum terpasang. Install Node.js 22 LTS dari https://nodejs.org lalu buka ulang PowerShell.'
}
$nodeVersion = [version]((node -v).TrimStart('v'))
if ($nodeVersion -lt [version]'22.18.0') {
  Fail "Node.js $nodeVersion terlalu lama. Butuh >= 22.18 (install Node.js 22 LTS terbaru)."
}
Write-Host "Node.js $nodeVersion OK"

# ---------------------------------------------------------------- 2. .env
Step 'Konfigurasi .env'
if (Test-Path .env) {
  Write-Host '.env sudah ada, tidak diubah.'
} else {
  $apiKey = RandomHex 24
  (Get-Content .env.example) -replace '^API_KEYS=.*$', "API_KEYS=$apiKey" | Set-Content .env -Encoding ascii
  Write-Host '.env dibuat dari .env.example.'
  Write-Host "API key Anda (simpan, dipakai di header x-api-key): $apiKey" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 3. PostgreSQL
Step 'Database PostgreSQL'
if ($NoDocker) {
  Write-Host 'Mode -NoDocker: pastikan PostgreSQL 16 berjalan, lalu buat user & database sekali saja (via psql/pgAdmin):'
  Write-Host "  CREATE ROLE ff LOGIN PASSWORD 'ff';"
  Write-Host '  CREATE DATABASE ff OWNER ff;'
  Write-Host '  CREATE DATABASE ff_test OWNER ff;'
  Write-Host 'Sesuaikan DATABASE_URL & TEST_DATABASE_URL di .env jika user/password/port berbeda.'
} else {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'Docker tidak ditemukan. Install Docker Desktop, atau jalankan ulang dengan -NoDocker jika memakai PostgreSQL biasa.'
  }
  Run docker @('compose', 'up', '-d', 'db')
  Write-Host 'Menunggu PostgreSQL siap...'
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    docker compose exec -T db pg_isready -U ff *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { Fail 'PostgreSQL tidak siap dalam 60 detik. Cek: docker compose logs db' }
  Write-Host 'PostgreSQL siap.'
}

# ---------------------------------------------------------------- 4. Build & migrasi
Step 'Install dependency (npm ci)'
Run npm @('ci')
Step 'Build'
Run npm @('run', 'build')
Step 'Migrasi database'
Run npm @('run', 'migrate')

# ---------------------------------------------------------------- 5. Test / start
if ($Test) {
  Step 'Test (unit + e2e; database *_test akan DIKOSONGKAN)'
  Run npm @('test')
}

Step 'Selesai'
Write-Host 'Start API        : npm start'
Write-Host 'Uji aplikasi     : powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1   (di jendela lain)'
Write-Host 'Upgrade versi    : git pull; lalu jalankan script ini lagi'
if ($Start) {
  Step 'Start API (Ctrl+C untuk berhenti)'
  npm start
}
