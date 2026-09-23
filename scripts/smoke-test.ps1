<#
.SYNOPSIS
  Uji cepat API yang sedang berjalan: health, buat job contoh, deadline, milestone, tampilan "Hari ini".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
  powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1 -BaseUrl http://localhost:3000 -ApiKey xxxxx
#>
param(
  [string]$BaseUrl = 'http://localhost:3000',
  [string]$ApiKey = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script:failed = 0

if (-not $ApiKey) {
  $envFile = Join-Path $root '.env'
  if (-not (Test-Path $envFile)) { throw '.env tidak ditemukan; isi -ApiKey atau jalankan scripts\setup-local.ps1 dulu.' }
  $line = Get-Content $envFile | Where-Object { $_ -match '^API_KEYS=' } | Select-Object -First 1
  $ApiKey = (($line -replace '^API_KEYS=', '') -split ',')[0].Trim()
  if (-not $ApiKey) { throw 'API_KEYS di .env kosong.' }
}
$headers = @{ 'x-api-key' = $ApiKey }

# Waktu UTC dengan format invariant: jangan pakai format lokal (id-ID memakai '.' sebagai pemisah jam).
function IsoUtc([double]$hoursFromNow) {
  return [DateTime]::UtcNow.AddHours($hoursFromNow).ToString("yyyy-MM-dd'T'HH':'mm':'ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

function Call([string]$method, [string]$path, $body = $null, [switch]$NoKey) {
  $p = @{ Method = $method; Uri = "$BaseUrl$path"; ContentType = 'application/json' }
  if (-not $NoKey) { $p.Headers = $headers }
  if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Depth 10) }
  try {
    return @{ status = 200; body = (Invoke-RestMethod @p) }
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    return @{ status = $status; body = $_.ErrorDetails.Message }
  }
}

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "[OK]    $name" -ForegroundColor Green }
  else { Write-Host "[GAGAL] $name $detail" -ForegroundColor Red; $script:failed++ }
}

Write-Host "Menguji $BaseUrl" -ForegroundColor Cyan

$r = Call GET '/health' -NoKey
Check 'GET /health' ($r.status -eq 200 -and $r.body.status -eq 'ok') ($r.body | Out-String)
if ($r.status -eq 0) { Write-Host 'API tidak bisa dihubungi. Sudah jalankan "npm start"?' -ForegroundColor Red; exit 1 }

$r = Call GET '/deadlines' -NoKey
Check 'tanpa API key ditolak (401)' ($r.status -eq 401) "status=$($r.status)"

$ref = 'SMOKE/' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss', [Globalization.CultureInfo]::InvariantCulture)
$job = @{
  reference  = $ref
  direction  = 'EXPORT'
  mode       = 'SEA'
  roles      = @('PPJK', 'NVOCC')
  masterDoc  = @{ vesselName = 'KMTC JAKARTA'; voyage = '2609N'; portOfLoading = 'IDJKT'; portOfDischarge = 'SGSIN'; etd = (IsoUtc 72) }
  containers = @(@{ number = 'KMTU1234567'; sizeType = '40HC' })
  carrierCutoffs = @{ SI = (IsoUtc 5); CY = (IsoUtc 30) }
  pic        = @{ DOCS = 'wa:+6281200000001'; CUSTOMS = 'wa:+6281200000002'; OPS = 'wa:+6281200000003' }
}
$r = Call POST '/jobs' $job
Check "POST /jobs ($ref)" ($r.status -eq 200 -and $r.body.job.id) ($r.body | Out-String)
if (-not $r.body.job.id) { exit 1 }
$id = $r.body.job.id

Write-Host ''
Write-Host "Deadline job $ref :" -ForegroundColor Cyan
$r.body.deadlines | Select-Object ruleCode, status, dueAt, hoursLeft, estimated | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

$si = $r.body.deadlines | Where-Object { $_.ruleCode -eq 'EXP_SI_CLOSING' }
Check 'SI closing 5 jam lagi = CRITICAL' ($si.status -eq 'CRITICAL') "status=$($si.status)"
$vgm = $r.body.deadlines | Where-Object { $_.ruleCode -eq 'EXP_VGM_CLOSING' }
Check 'VGM tanpa cut-off = ESTIMASI dari ETD' ($vgm.estimated -eq $true) "estimated=$($vgm.estimated)"

$r = Call POST "/jobs/$id/milestones" @{ event = 'SI_SUBMITTED'; occurredAt = (IsoUtc -0.1) }
$si = $r.body.deadlines | Where-Object { $_.ruleCode -eq 'EXP_SI_CLOSING' }
Check 'milestone SI_SUBMITTED -> SI closing DONE' ($si.status -eq 'DONE') "status=$($si.status)"

$r = Call POST "/jobs/$id/milestones" @{ event = 'SI_SUBMITTED'; occurredAt = (IsoUtc 3) }
Check 'milestone di masa depan ditolak (400)' ($r.status -eq 400) "status=$($r.status)"

$r = Call PATCH "/jobs/$id" @{ carrierCutoffs = @{ VGM = (IsoUtc 20) } }
$vgm = $r.body.deadlines | Where-Object { $_.ruleCode -eq 'EXP_VGM_CLOSING' }
Check 'PATCH cut-off VGM -> bukan estimasi lagi' ($r.status -eq 200 -and $vgm.estimated -eq $false) "estimated=$($vgm.estimated)"

$r = Call GET '/deadlines?owner=DOCS'
Check 'GET /deadlines?owner=DOCS' ($r.status -eq 200) "status=$($r.status)"
Write-Host ''
Write-Host 'Tampilan "Hari ini" untuk PIC DOCS:' -ForegroundColor Cyan
@($r.body) | Select-Object jobReference, ruleCode, status, dueAt, pic | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

$r = Call POST "/jobs/$id/close"
Check 'tutup job contoh' ($r.status -eq 200 -and $r.body.status -eq 'CLOSED') "status=$($r.status)"

Write-Host ''
if ($script:failed -eq 0) {
  Write-Host 'Semua cek lulus. Alarm untuk job contoh muncul di log API (atau di n8n jika webhook diisi) pada tick berikutnya.' -ForegroundColor Green
  exit 0
}
Write-Host "$($script:failed) cek gagal." -ForegroundColor Red
exit 1
