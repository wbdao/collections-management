# Verifies that a `clasp push` from either the repository root or apps-script/
# uploads exactly the Apps Script manifest plus all 28 .gs source files.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-clasp.ps1
$root = 'D:\Collecting'
$src  = Join-Path $root 'apps-script'
$errors = @()

function Read-Utf8($path) { [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) }

$gsFiles = Get-ChildItem -Path $src -Recurse -File -Filter '*.gs' | Sort-Object FullName
$names = @{}
foreach ($f in $gsFiles) {
  if ($names.ContainsKey($f.Name)) { $errors += "Duplicate .gs file name: $($f.Name)" }
  else { $names[$f.Name] = $true }
}

# --- Duplicate top-level global names (Apps Script has one shared namespace) ---
$declarations = @{}
foreach ($f in $gsFiles) {
  $rel = $f.FullName.Replace("$root\", '')
  $lines = Get-Content -LiteralPath $f.FullName -Encoding UTF8
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match '^(var|const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)') {
      $n = $Matches[2]
      if (-not $declarations.ContainsKey($n)) { $declarations[$n] = @() }
      $declarations[$n] += "${rel}:$($i+1)"
    }
    if ($line -match '^function\s+([A-Za-z_$][A-Za-z0-9_$]*)') {
      $n = $Matches[1]
      if (-not $declarations.ContainsKey($n)) { $declarations[$n] = @() }
      $declarations[$n] += "${rel}:$($i+1)"
    }
  }
}
foreach ($n in $declarations.Keys) {
  if ($declarations[$n].Count -gt 1) {
    $errors += "Duplicate global '$n' at " + ($declarations[$n] -join ', ')
  }
}

# --- Required entry points / layers present ---
foreach ($must in @('Code.gs','bootstrap.gs','config.gs','constants.gs','router.gs','triggers.gs',
                    'data\tables.gs','repository\sheets-adapter.gs','services\customer-master-service.gs',
                    'services\tracking-service.gs','utils\errors.gs','utils\helpers.gs','utils\response.gs')) {
  if (-not (Test-Path (Join-Path $src $must))) { $errors += "Missing required file: apps-script\$must" }
}
$code = Read-Utf8 (Join-Path $src 'Code.gs')
foreach ($entry in @('function doGet','function doPost')) {
  if ($code -notmatch [regex]::Escape($entry)) { $errors += "Missing Apps Script entry point: $entry" }
}

# --- Manifest ---
$manifest = Read-Utf8 (Join-Path $src 'appsscript.json')
foreach ($token in @('"runtimeVersion"', '"webapp"', '"oauthScopes"',
                     'auth/spreadsheets', 'auth/script.external_request', 'auth/script.scriptapp')) {
  if ($manifest -notmatch [regex]::Escape($token)) { $errors += "appsscript.json missing: $token" }
}

# --- CLASP configs point at the Apps Script sources only ---
$rootCfg = Read-Utf8 (Join-Path $root '.clasp.json')
$srcCfg  = Read-Utf8 (Join-Path $src '.clasp.json')
if ($rootCfg -notmatch '"rootDir"\s*:\s*"apps-script"') { $errors += 'Root .clasp.json rootDir must be "apps-script"' }
if ($srcCfg  -notmatch '"rootDir"\s*:\s*"\."') { $errors += 'apps-script/.clasp.json rootDir must be "."' }
$scriptIdMatch = [regex]::Match($rootCfg, '"scriptId"\s*:\s*"([^"]+)"')
if (-not $scriptIdMatch.Success -or $scriptIdMatch.Groups[1].Value.Length -lt 20) {
  $errors += 'Root .clasp.json has no valid scriptId'
} elseif ($srcCfg -notmatch [regex]::Escape($scriptIdMatch.Groups[1].Value)) {
  $errors += 'Both .clasp.json files must use the same scriptId'
}
foreach ($ignorePath in @((Join-Path $root '.claspignore'), (Join-Path $src '.claspignore'))) {
  if (-not (Test-Path $ignorePath)) { $errors += "Missing $ignorePath" }
  else {
    $ignore = Read-Utf8 $ignorePath
    if ($ignore -notmatch [regex]::Escape('!**/*.gs')) { $errors += "$ignorePath must allow !**/*.gs" }
    if ($ignore -notmatch [regex]::Escape('!appsscript.json')) { $errors += "$ignorePath must allow !appsscript.json" }
  }
}

Write-Output "Checked $($gsFiles.Count) .gs files and $($declarations.Count) global declarations"
if ($errors.Count) {
  $errors | ForEach-Object { Write-Output "FAIL $_" }
  exit 1
}
Write-Output 'OK: clasp push will upload exactly the manifest and all .gs files; no duplicate globals'
