#!/usr/bin/env python3
"""
local-voice-worker.py — Offline Local Voice Worker for MediBot Phase 4
----------------------------------------------------------------------
Reuses existing local models on disk (0 downloads, 0 paid APIs):
  - STT: faster-whisper (Systran/faster-whisper-small, local_files_only=True)
  - TTS: kokoro-onnx (kokoro-v1.0.onnx + voices-v1.0.bin)
         Hindi voices: hf_alpha (female), hm_omega (male)
         English voices: af_heart (female)
  - Audio conversion: local FFmpeg (only when browser sends WebM/OGG/MP4)

Protocol: newline-delimited JSON on stdin -> newline-delimited JSON on stdout.
Commands:
  {"id": 1, "cmd": "ping"}
  {"id": 2, "cmd": "transcribe", "audio_base64": "...", "mime_type": "audio/webm", "language": "hi"|null}
  {"id": 3, "cmd": "synthesize", "text": "...", "lang": "hi"|"hinglish"|"en"}
"""

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave

# Ensure UTF-8 I/O on Windows
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

KOKORO_MODEL = os.environ.get(
    "LOCAL_KOKORO_MODEL",
    os.path.join(os.path.expanduser("~"), ".faceless-shorts", "kokoro", "kokoro-v1.0.onnx"),
)
KOKORO_VOICES = os.environ.get(
    "LOCAL_KOKORO_VOICES",
    os.path.join(os.path.expanduser("~"), ".faceless-shorts", "kokoro", "voices-v1.0.bin"),
)
WHISPER_MODEL_SIZE = os.environ.get("LOCAL_WHISPER_MODEL", "small")
FFMPEG_BIN = os.environ.get("LOCAL_FFMPEG_PATH", "") or shutil.which("ffmpeg") or ""

_whisper_model = None
_kokoro_model = None


def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel(
            WHISPER_MODEL_SIZE,
            device="cpu",
            compute_type="int8",
            local_files_only=True,
        )
    return _whisper_model


def get_kokoro():
    global _kokoro_model
    if _kokoro_model is None:
        import kokoro_onnx
        if not os.path.isfile(KOKORO_MODEL) or not os.path.isfile(KOKORO_VOICES):
            raise FileNotFoundError(f"Kokoro model files not found at {KOKORO_MODEL}")
        _kokoro_model = kokoro_onnx.Kokoro(KOKORO_MODEL, KOKORO_VOICES)
    return _kokoro_model


def samples_to_wav_bytes(samples, sample_rate):
    import numpy as np
    pcm = np.clip(samples, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def convert_to_wav_if_needed(raw_bytes, mime_type):
    """Writes audio to a temp file and converts non-WAV formats via local FFmpeg."""
    mime = (mime_type or "").lower()
    is_wav = "wav" in mime or (len(raw_bytes) >= 4 and raw_bytes[:4] == b"RIFF")

    suffix = ".wav" if is_wav else (".ogg" if "ogg" in mime else ".webm")
    in_fd, in_path = tempfile.mkstemp(prefix="medibot_in_", suffix=suffix)
    os.close(in_fd)
    with open(in_path, "wb") as f:
        f.write(raw_bytes)

    if is_wav:
        return in_path, [in_path]

    if not FFMPEG_BIN:
        # Try passing directly to faster-whisper (PyAV can decode webm/ogg in many builds)
        return in_path, [in_path]

    out_fd, out_path = tempfile.mkstemp(prefix="medibot_wav_", suffix=".wav")
    os.close(out_fd)
    try:
        proc = subprocess.run(
            [FFMPEG_BIN, "-y", "-i", in_path, "-ar", "16000", "-ac", "1", "-f", "wav", out_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=15,
        )
        if proc.returncode == 0 and os.path.getsize(out_path) > 44:
            return out_path, [in_path, out_path]
    except Exception:
        pass
    return in_path, [in_path, out_path]


def handle_transcribe(req):
    audio_b64 = req.get("audio_base64") or ""
    if not audio_b64:
        return {"ok": False, "error": "Empty audio payload"}

    raw_bytes = base64.b64decode(audio_b64)
    if len(raw_bytes) < 100:
        return {"ok": True, "text": "", "language": ""}

    mime_type = req.get("mime_type") or "audio/webm"
    req_lang = req.get("language")
    # For Hinglish or auto, let Whisper auto-detect between Hindi & English
    whisper_lang = req_lang if req_lang in ("hi", "en") else None

    wav_path, cleanup_paths = convert_to_wav_if_needed(raw_bytes, mime_type)
    try:
        model = get_whisper()
        segments, info = model.transcribe(
            wav_path,
            language=whisper_lang,
            beam_size=1,
            vad_filter=True,
        )
        text = " ".join(seg.text.strip() for seg in segments if seg.text).strip()
        return {
            "ok": True,
            "text": text,
            "language": getattr(info, "language", "") or "",
        }
    finally:
        for p in cleanup_paths:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass


def handle_synthesize(req):
    text = (req.get("text") or "").strip()
    if not text:
        return {"ok": False, "error": "Empty text for synthesis"}

    lang = (req.get("lang") or "hi").lower()
    # Select Kokoro voice & language
    if lang == "en":
        voice = "af_heart"
        kokoro_lang = "en-us"
    else:
        # Both Hindi (Devanagari) and Hinglish use Hindi female voice hf_alpha
        voice = "hf_alpha"
        kokoro_lang = "hi"

    kokoro = get_kokoro()
    samples, sr = kokoro.create(text, voice=voice, speed=1.0, lang=kokoro_lang)
    wav_bytes = samples_to_wav_bytes(samples, sr)
    return {
        "ok": True,
        "audio_base64": base64.b64encode(wav_bytes).decode("ascii"),
        "mime_type": "audio/wav",
        "voice": voice,
        "lang": kokoro_lang,
        "sample_rate": int(sr),
        "duration_seconds": round(len(samples) / float(sr), 2),
    }


def main():
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            cmd = req.get("cmd")
            if cmd == "ping":
                resp = {
                    "ok": True,
                    "whisper_model": WHISPER_MODEL_SIZE,
                    "kokoro_exists": os.path.isfile(KOKORO_MODEL) and os.path.isfile(KOKORO_VOICES),
                    "ffmpeg": bool(FFMPEG_BIN),
                }
            elif cmd == "transcribe":
                resp = handle_transcribe(req)
            elif cmd == "synthesize":
                resp = handle_synthesize(req)
            else:
                resp = {"ok": False, "error": f"Unknown command: {cmd}"}
        except Exception as e:
            resp = {"ok": False, "error": str(e)}

        resp["id"] = req_id
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
