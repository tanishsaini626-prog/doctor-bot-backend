$target = 'C:/Users/saini/doctor-bot-backend/server.js'
$content = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)

$cr = [char][System.Environment]::NewLine
if ($content -match '\r?\n') { $nl = $matches[0] } else { $nl = [char][System.Environment]::NewLine }

$marker = '// ---- 1. environment -------------------------------------------------'
$idx = $content.IndexOf($marker)
if ($idx -lt 0) { Write-Host 'marker not found'; exit 1 }
$endMarker = 'const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, ''.data'', ''store.json'');'
$endIdx = $content.IndexOf($endMarker)
if ($endIdx -lt 0) { Write-Host 'end marker not found'; exit 1 }

$oldBlock = $content.Substring($idx, $endIdx - $idx + $endMarker.Length)

$assert = @'
// --- configuration validation (fail fast on production-required secrets) ---
function assertEnv(name) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === '') {
    console.error('FATAL: Missing required environment variable: ' + name);
    process.exit(1);
  }
  return value;
}
'@

$newBlock = $oldBlock.Substring(0, $oldBlock.IndexOf('const PORT = process.env.PORT || 5000;') + 'const PORT = process.env.PORT || 5000;'.Length)
$newBlock = $newBlock.Replace('const PORT = process.env.PORT || 5000;', 'const PORT = assertEnv(''PORT'') || 5000;')
$newBlock = $newBlock.Replace('const MONGODB_URI = process.env.MONGODB_URI || '';', 'const MONGODB_URI = assertEnv(''MONGODB_URI'');   // fail fast if missing in production' + $cr)
$cr = [char][System.Environment]::NewLine
$extra = $cr + '// --- storage mode / database configuration ---' + $cr + 'const MONGODB_URI_REQUIRED = String(process.env.STORE_MODE || '''.'').toLowerCase() !== ''mongo'';' + $cr
# append a comment block for documentation; keep STORE_MODE handling explicit in initStore later (Phase 5)
$newBlock = $newBlock + $cr + $cr

$content = $content.Substring(0, $idx) + $newBlock + $content.Substring($endIdx + $endMarker.Length)

[System.IO.File]::WriteAllText($target, $content, [System.Text.Encoding]::UTF8)
Write-Host 'server.js head patched OK'
