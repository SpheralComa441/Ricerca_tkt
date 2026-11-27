# Configurazione una-tantum dell'aggiornamento automatico di Ricerca TKT (Edge e Chrome su Windows).
# Non richiede privilegi di amministratore (usa solo HKCU).

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$updaterDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $updaterDir
$extDir = Join-Path $repoDir "extension"
$hostBat = Join-Path $updaterDir "host.bat"
$manifestPath = Join-Path $updaterDir "it.ricercatkt.updater.json"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Ricerca TKT - Attivazione aggiornamento automatico" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Cartella estensione: $extDir"

if (-not (Test-Path -LiteralPath (Join-Path $extDir "manifest.json"))) {
  Write-Host "ERRORE: extension\manifest.json non trovato accanto alla cartella updater." -ForegroundColor Red
  exit 1
}

function Normalize-PathStr([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return "" }
  try { return [System.IO.Path]::GetFullPath($p).TrimEnd('\').ToLowerInvariant() } catch { return $p.TrimEnd('\').ToLowerInvariant() }
}

$targetNorm = Normalize-PathStr $extDir
$foundIds = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

# Ricerca automatica dell'ID estensione nei profili Edge e Chrome locali
$browserRoots = @(
  (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data"),
  (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"),
  (Join-Path $env:LOCALAPPDATA "BraveSoftware\Brave-Browser\User Data")
)

foreach ($root in $browserRoots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    foreach ($prefName in @("Secure Preferences", "Preferences")) {
      $prefPath = Join-Path $_.FullName $prefName
      if (-not (Test-Path -LiteralPath $prefPath)) { continue }
      try {
        $raw = Get-Content -LiteralPath $prefPath -Raw -Encoding UTF8 -ErrorAction Stop
        if ($raw -notmatch "Ricerca TKT") { continue }
        $json = $raw | ConvertFrom-Json
        $settings = $json.extensions.settings
        if ($null -eq $settings) { continue }
        foreach ($prop in $settings.PSObject.Properties) {
          $entry = $prop.Value
          $entryPath = Normalize-PathStr ([string]$entry.path)
          $entryName = if ($entry.manifest) { [string]$entry.manifest.name } else { "" }
          if ($entryPath -eq $targetNorm -or ($entryName -eq "Ricerca TKT" -and $entryPath -like "*\extension")) {
            $null = $foundIds.Add($prop.Name)
          }
        }
      } catch {
        # Ignora profili bloccati o illeggibili
      }
    }
  }
}

if ($foundIds.Count -gt 0) {
  Write-Host ""
  Write-Host "ID estensione rilevati automaticamente:" -ForegroundColor Green
  foreach ($id in $foundIds) { Write-Host "  - $id" -ForegroundColor White }
} else {
  Write-Host ""
  Write-Host "Non ho trovato automaticamente l'ID estensione in Edge/Chrome." -ForegroundColor Yellow
  Write-Host "Apri Ricerca TKT -> Diagnostica -> Aggiornamenti -> Copia ID estensione" -ForegroundColor Gray
  Write-Host "(oppure copialo da edge://extensions / chrome://extensions)." -ForegroundColor Gray
  Write-Host ""
  $manual = (Read-Host "Incolla qui l'ID dell'estensione (32 lettere)").Trim().ToLowerInvariant()
  if ($manual -notmatch "^[a-p]{32}$") {
    Write-Host "ERRORE: ID non valido (deve contenere 32 lettere minuscole tra 'a' e 'p')." -ForegroundColor Red
    exit 1
  }
  $null = $foundIds.Add($manual)
}

$origins = @()
foreach ($id in $foundIds) { $origins += "chrome-extension://$id/" }

$hostManifest = [ordered]@{
  name = "it.ricercatkt.updater"
  description = "Aggiornamento automatico per l'estensione Ricerca TKT"
  path = $hostBat
  type = "stdio"
  allowed_origins = $origins
}

$manifestJson = $hostManifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)

# Registrazione su HKCU sia per Edge che per Chrome (nessun privilegio admin richiesto)
$regKeys = @(
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\it.ricercatkt.updater",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\it.ricercatkt.updater"
)
foreach ($rk in $regKeys) {
  if (-not (Test-Path -LiteralPath $rk)) {
    $null = New-Item -Path $rk -Force
  }
  Set-ItemProperty -Path $rk -Name "(Default)" -Value $manifestPath
}

Write-Host ""
Write-Host "FATTO! Aggiornamento automatico attivato per Edge e Chrome." -ForegroundColor Green
Write-Host "Manifesto salvato in: $manifestPath" -ForegroundColor Gray
Write-Host ""
Write-Host "Da adesso Ricerca TKT potra scaricare e installare gli aggiornamenti da sola" -ForegroundColor White
Write-Host "senza piu dover aprire GitHub o edge://extensions." -ForegroundColor White
Write-Host ""
