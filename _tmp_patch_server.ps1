$target = 'C:/Users/saini/doctor-bot-backend/server.js'
$content = [System.IO.File]::ReadAllText($target, [System.Text.Encoding]::UTF8)
$nl = "`r`n"

# --- 1. Validate environment at startup (fail fast) ---
$oldHead = @'
// ---- 1. environment ------------------------------------------------------
// dotenv reads every listed file, so ".env" OR "doctor.env" both work here.
require('dotenv').config({ path: ['.env', 'doctor.env', '.env.local'] });

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const BotEngine = require('./bot-engine');
const { createConversation } = require('./conversation');
const { createMongoStore } = require('./store-mongo');
const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');
const { createAuth, requireAuth, ensureSeedAdmin } = require('./auth');
const { requireTwilioSignature } = require('./twilio-signature');

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const MAX_PER_SLOT = parseInt(process.env.MAX_PER_SLOT || '0', 10);   // 0 = unlimited
const STORE_MODE = (process.env.STORE || 'auto').toLowerCase();       // auto | mongo | file | memory
// Where the file-backed store keeps its JSON (ignored by git via .data/).
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '.data', 'store.json');
'@

$newHead = @'
// ---- 1. environment ------------------------------------------------------
// dotenv reads every listed file, so ".env" OR "doctor.env" both work here.
require('dotenv').config({ path: ['.env', 'doctor.env', '.env.local'] });

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const BotEngine = require('./bot-engine');
const { createConversation } = require('./conversation');
const { createMongoStore } = require('./store-mongo');
const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');
const { createAuth, requireAuth, ensureSeedAdmin } = require('./auth');
const { requireTwilioSignature } = require('./twilio-signature');

// --- configuration validation (fail fast on production-required secrets) ---
function assertEnv(name) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === '') {
    console.error('FATAL: Missing required environment variable: ' + name);
    process.exit(1);
  }
  return value;
}
const PORT = assertEnv('PORT') || 5000;
const MONGODB_URI = assertEnv('MONGODB_URI');   // fail fast if missing in production
const MAX_PER_SLOT = parseInt(process.env.MAX_PER_SLOT || '0', 10);   // 0 = unlimited
const STORE_MODE = (process.env.STORE || 'auto').toLowerCase();       // auto | mongo | file | memory
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '.data', 'store.json');
'@

if ($content -replace "`r`n", "`n") { $content = $content } // no-op
$content = $content.Replace($oldHead, $newHead)
if ($content -eq $content) { } # keep unchanged if no change
[System.IO.File]::WriteAllText($target, $content, [System.Text.Encoding]::UTF8)
Write-Host "server.js head patched"
'@ -replace('`r`n','`r`n')
$scriptPath = 'd:\Projects\doctor-bot-audio\_tmp_patch_server.ps1'
[System.IO.File]::WriteAllText($scriptPath, $script, [System.Text.Encoding]::UTF8)
Write-Host 'script written to' $scriptPath
