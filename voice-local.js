'use strict';
/**
 * voice-local.js — Local Offline Whisper STT & Kokoro TTS Bridge (Phase 4)
 * ------------------------------------------------------------------------
 * Reuses existing local models on disk with zero paid APIs or downloads:
 *   - faster-whisper (Systran/faster-whisper-small)
 *   - kokoro-onnx (kokoro-v1.0.onnx + voices-v1.0.bin)
 *   - local FFmpeg (for browser WebM/OGG -> 16kHz WAV conversion)
 *
 * Lazily spawns scripts/local-voice-worker.py on first voice call so normal
 * server boot and non-voice tests incur zero overhead.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKER_SCRIPT = path.join(__dirname, 'scripts', 'local-voice-worker.py');

function detectLocalPaths() {
  const home = os.homedir();
  const defaultVenvPy = path.join(home, '.faceless-shorts', 'venv', 'Scripts', 'python.exe');
  const pythonBin = process.env.LOCAL_VOICE_PYTHON
    || (fs.existsSync(defaultVenvPy) ? defaultVenvPy : null);

  const kokoroModel = process.env.LOCAL_KOKORO_MODEL
    || path.join(home, '.faceless-shorts', 'kokoro', 'kokoro-v1.0.onnx');
  const kokoroVoices = process.env.LOCAL_KOKORO_VOICES
    || path.join(home, '.faceless-shorts', 'kokoro', 'voices-v1.0.bin');
  const whisperCache = path.join(home, '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-small');

  return {
    pythonBin,
    kokoroModel,
    kokoroVoices,
    kokoroAvailable: !!(pythonBin && fs.existsSync(kokoroModel) && fs.existsSync(kokoroVoices)),
    whisperAvailable: !!(pythonBin && fs.existsSync(whisperCache)),
    workerScriptExists: fs.existsSync(WORKER_SCRIPT),
  };
}

function createLocalVoiceEngine(opts = {}) {
  const disabled = String(process.env.LOCAL_VOICE_DISABLED || 'false').toLowerCase() === 'true' || !!opts.disabled;
  let worker = null;
  let reqSeq = 1;
  let stdoutBuf = '';
  const pending = new Map();

  function getCapabilities() {
    if (disabled) {
      return {
        available: false,
        stt: { available: false, engine: 'disabled', model: null },
        tts: { available: false, engine: 'disabled', model: null, voices: [] },
        fallback_modes: ['browser_web_speech', 'text_input'],
      };
    }
    const paths = detectLocalPaths();
    const sttOk = paths.whisperAvailable && paths.workerScriptExists;
    const ttsOk = paths.kokoroAvailable && paths.workerScriptExists;
    return {
      available: sttOk || ttsOk,
      stt: {
        available: sttOk,
        engine: sttOk ? 'faster-whisper' : 'unavailable',
        model: sttOk ? 'Systran/faster-whisper-small (offline int8)' : null,
        languages: ['hi', 'hinglish', 'en'],
      },
      tts: {
        available: ttsOk,
        engine: ttsOk ? 'kokoro-onnx' : 'unavailable',
        model: ttsOk ? 'kokoro-v1.0.onnx' : null,
        voices: ttsOk ? ['hf_alpha (Hindi/Hinglish)', 'af_heart (English)'] : [],
      },
      fallback_modes: ['browser_web_speech', 'text_input'],
    };
  }

  function failAllPending(reason) {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, fallback: true, error: reason });
      pending.delete(id);
    }
  }

  function ensureWorker() {
    if (disabled) return null;
    if (worker && !worker.killed && worker.exitCode === null) return worker;

    const paths = detectLocalPaths();
    if (!paths.pythonBin || !paths.workerScriptExists) return null;

    worker = spawn(paths.pythonBin, [WORKER_SCRIPT], {
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',
        LOCAL_KOKORO_MODEL: paths.kokoroModel,
        LOCAL_KOKORO_VOICES: paths.kokoroVoices,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    stdoutBuf = '';
    worker.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const entry = pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            pending.delete(msg.id);
            entry.resolve(msg);
          }
        } catch (_) {}
      }
    });

    worker.on('error', (err) => {
      worker = null;
      failAllPending(`Local voice worker error: ${err.message}`);
    });

    worker.on('exit', () => {
      worker = null;
      failAllPending('Local voice worker exited unexpectedly');
    });

    return worker;
  }

  function sendCommand(payload, timeoutMs = 25000) {
    return new Promise((resolve) => {
      const proc = ensureWorker();
      if (!proc) {
        return resolve({
          ok: false,
          fallback: true,
          error: 'Local voice models (Whisper/Kokoro) are not configured on this host',
        });
      }
      const id = reqSeq++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, fallback: true, error: 'Local voice processing timed out' });
      }, timeoutMs);

      pending.set(id, { resolve, timer });
      try {
        proc.stdin.write(JSON.stringify(Object.assign({ id }, payload)) + '\n');
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, fallback: true, error: err.message });
      }
    });
  }

  async function transcribe({ audio_base64, mime_type = 'audio/webm', language = null }) {
    if (!audio_base64) {
      return { ok: false, error: 'Empty audio input' };
    }
    return sendCommand({
      cmd: 'transcribe',
      audio_base64,
      mime_type,
      language,
    }, 60000);
  }

  async function synthesize({ text, lang = 'hi' }) {
    if (!text || !String(text).trim()) {
      return { ok: false, error: 'Empty text input' };
    }
    return sendCommand({
      cmd: 'synthesize',
      text: String(text).trim(),
      lang,
    }, 45000);
  }

  async function warmup() {
    const caps = getCapabilities();
    if (!caps.available) {
      return { ok: false, warmed: false, available: false, reason: 'Local voice models not available on this host' };
    }
    const res = await sendCommand({ cmd: 'ping' }, 15000);
    return {
      ok: !!(res && res.ok),
      warmed: !!(res && res.ok),
      available: true,
      whisper_model: res && res.whisper_model ? res.whisper_model : null,
      kokoro_exists: !!(res && res.kokoro_exists),
      ffmpeg: !!(res && res.ffmpeg),
    };
  }

  function shutdown() {
    if (worker && !worker.killed) {
      try { worker.kill('SIGTERM'); } catch (_) {}
    }
    worker = null;
    failAllPending('Local voice engine shut down');
  }

  return {
    getCapabilities,
    transcribe,
    synthesize,
    warmup,
    shutdown,
  };
}

module.exports = {
  createLocalVoiceEngine,
  detectLocalPaths,
};
