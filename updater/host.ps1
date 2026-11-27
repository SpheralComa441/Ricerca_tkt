# Native Messaging Host per l'aggiornamento automatico di Ricerca TKT (Windows PowerShell 5.1+ / 7+).
# Riceve messaggi JSON incorniciati da 4 byte little-endian su stdin e risponde su stdout.
# Sicurezza: scrive ESCLUSIVAMENTE nella cartella padre di questo script (mai percorsi arbitrari).

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-ExactBytes([System.IO.Stream]$stream, [int]$count) {
  $buf = New-Object byte[] $count
  $offset = 0
  while ($offset -lt $count) {
    $n = $stream.Read($buf, $offset, $count - $offset)
    if ($n -le 0) { return $null }
    $offset += $n
  }
  return $buf
}

function Read-NativeMessage {
  $lenBytes = Read-ExactBytes $stdin 4
  if ($null -eq $lenBytes) { return $null }
  $len = [BitConverter]::ToUInt32($lenBytes, 0)
  if ($len -eq 0 -or $len -gt 67108864) { return $null }
  $payloadBytes = Read-ExactBytes $stdin ([int]$len)
  if ($null -eq $payloadBytes) { return $null }
  $json = $utf8NoBom.GetString($payloadBytes)
  try {
    Add-Type -AssemblyName System.Web.Extensions -ErrorAction SilentlyContinue
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = 67108864
    return $ser.DeserializeObject($json)
  } catch {
    return ($json | ConvertFrom-Json)
  }
}

function Write-NativeMessage($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  $bytes = $utf8NoBom.GetBytes($json)
  $lenBytes = [BitConverter]::GetBytes([uint32]$bytes.Length)
  $stdout.Write($lenBytes, 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Copy-TreeClean([string]$srcDir, [string]$dstDir, [string[]]$preserveNames = @()) {
  if (-not (Test-Path -LiteralPath $dstDir)) {
    $null = New-Item -ItemType Directory -Path $dstDir -Force
  }
  $srcFull = (Resolve-Path -LiteralPath $srcDir).Path.TrimEnd('\')
  $dstFull = (Resolve-Path -LiteralPath $dstDir).Path.TrimEnd('\')
  $copied = 0
  $expectedRel = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

  Get-ChildItem -LiteralPath $srcFull -Recurse -Force | ForEach-Object {
    $rel = $_.FullName.Substring($srcFull.Length + 1)
    $null = $expectedRel.Add($rel)
    $target = Join-Path $dstFull $rel
    if ($_.PSIsContainer) {
      if (-not (Test-Path -LiteralPath $target)) {
        $null = New-Item -ItemType Directory -Path $target -Force
      }
    } else {
      $parent = Split-Path -Path $target -Parent
      if (-not (Test-Path -LiteralPath $parent)) {
        $null = New-Item -ItemType Directory -Path $parent -Force
      }
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
      $copied++
    }
  }

  # Rimuove file obsoleti non più presenti nella nuova versione (preservando i file protetti)
  $preserveSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($p in $preserveNames) { $null = $preserveSet.Add($p) }

  Get-ChildItem -LiteralPath $dstFull -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($dstFull.Length + 1)
    if (-not $expectedRel.Contains($rel) -and -not $preserveSet.Contains($rel) -and -not $preserveSet.Contains($_.Name)) {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
  }
  return $copied
}

function Apply-ZipBase64([string]$zipBase64, [string]$installDir) {
  if ([string]::IsNullOrWhiteSpace($zipBase64)) {
    throw "Archivio ZIP vuoto."
  }
  $zipBytes = [Convert]::FromBase64String($zipBase64)
  if ($zipBytes.Length -lt 4 -or $zipBytes[0] -ne 0x50 -or $zipBytes[1] -ne 0x4B) {
    throw "File ricevuto non valido (intestazione ZIP mancante)."
  }

  $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ricerca_tkt_upd_" + [Guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $tmpRoot "update.zip"
  $extractDir = Join-Path $tmpRoot "extract"
  $null = New-Item -ItemType Directory -Path $extractDir -Force

  try {
    [System.IO.File]::WriteAllBytes($zipPath, $zipBytes)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
      $extractFull = (Resolve-Path -LiteralPath $extractDir).Path.TrimEnd('\') + '\'
      foreach ($entry in $archive.Entries) {
        $destPath = [System.IO.Path]::GetFullPath((Join-Path $extractDir $entry.FullName))
        if (-not $destPath.StartsWith($extractFull, [System.StringComparison]::OrdinalIgnoreCase)) {
          throw "Percorso non sicuro nell'archivio ZIP: $($entry.FullName)"
        }
        if ([string]::IsNullOrEmpty($entry.Name)) {
          $null = New-Item -ItemType Directory -Path $destPath -Force
        } else {
          $dir = Split-Path -Path $destPath -Parent
          if (-not (Test-Path -LiteralPath $dir)) {
            $null = New-Item -ItemType Directory -Path $dir -Force
          }
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destPath, $true)
        }
      }
    } finally {
      $archive.Dispose()
    }

    $manifestHit = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter "manifest.json" -File |
      Where-Object { (Split-Path (Split-Path $_.FullName -Parent) -Leaf) -ieq "extension" } |
      Select-Object -First 1

    if (-not $manifestHit) {
      throw "Cartella extension\manifest.json non trovata nell'archivio scaricato."
    }

    $manifestData = (Get-Content -LiteralPath $manifestHit.FullName -Raw -Encoding UTF8) | ConvertFrom-Json
    if ($manifestData.name -ne "Ricerca TKT") {
      throw "Archivio non riconosciuto (nome estensione: $($manifestData.name))."
    }

    $srcExtDir = Split-Path -Path $manifestHit.FullName -Parent
    $srcRepoRoot = Split-Path -Path $srcExtDir -Parent
    $dstExtDir = Join-Path $installDir "extension"
    $count = Copy-TreeClean -srcDir $srcExtDir -dstDir $dstExtDir

    $srcUpdaterDir = Join-Path $srcRepoRoot "updater"
    $dstUpdaterDir = Join-Path $installDir "updater"
    if (Test-Path -LiteralPath $srcUpdaterDir) {
      $count += Copy-TreeClean -srcDir $srcUpdaterDir -dstDir $dstUpdaterDir -preserveNames @("it.ricercatkt.updater.json")
    }

    $srcBat = Join-Path $srcRepoRoot "aggiorna.bat"
    if (Test-Path -LiteralPath $srcBat) {
      Copy-Item -LiteralPath $srcBat -Destination (Join-Path $installDir "aggiorna.bat") -Force
    }

    return @{
      ok = $true
      version = [string]$manifestData.version
      filesUpdated = $count
    }
  } finally {
    Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = Split-Path -Parent $scriptDir
$hasGit = Test-Path -LiteralPath (Join-Path $installDir ".git")

try {
  $msg = Read-NativeMessage
  if ($null -eq $msg) { exit 0 }
  $action = [string]$msg["action"]
  if (-not $action -and $msg.action) { $action = [string]$msg.action }

  switch ($action) {
    "ping" {
      Write-NativeMessage @{
        ok = $true
        helperVersion = "1.0"
        installDir = $installDir
        hasGit = $hasGit
      }
    }
    "applyZip" {
      $zipB64 = if ($msg -is [System.Collections.IDictionary]) { [string]$msg["zipBase64"] } else { [string]$msg.zipBase64 }
      $res = Apply-ZipBase64 -zipBase64 $zipB64 -installDir $installDir
      Write-NativeMessage $res
    }
    "gitPull" {
      if (-not $hasGit) {
        Write-NativeMessage @{ ok = $false; error = "La cartella non è un repository Git." }
      } else {
        $out = & git -C $installDir pull --ff-only origin main 2>&1
        if ($LASTEXITCODE -ne 0) {
          Write-NativeMessage @{ ok = $false; error = "git pull fallito: $($out -join ' ')" }
        } else {
          $mPath = Join-Path $installDir "extension\manifest.json"
          $ver = ""
          if (Test-Path -LiteralPath $mPath) {
            $ver = ((Get-Content -LiteralPath $mPath -Raw -Encoding UTF8) | ConvertFrom-Json).version
          }
          Write-NativeMessage @{ ok = $true; version = [string]$ver; filesUpdated = 0; output = ($out -join "`n") }
        }
      }
    }
    default {
      Write-NativeMessage @{ ok = $false; error = "Azione non supportata: $action" }
    }
  }
} catch {
  Write-NativeMessage @{ ok = $false; error = $_.Exception.Message }
}
