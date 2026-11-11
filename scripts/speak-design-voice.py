#!/usr/bin/env python3
"""Create the reference WAV of a gentle-speak custom voice (S14, T42).

Run with the same flags as the Qwen worker: `python -E -P speak-design-voice.py <mode> ...`.

  design --description <text> --sample <sentence> --language es --out <dir> [--dry-run]
      Qwen3-TTS VoiceDesign 1.7B invents a voice from the text description (no reference audio of anyone)
      and speaks <sentence>. `--dry-run` skips model loading and writes a sine tone (tests only).
  import --wav <path> --transcript <text> --out <dir> [--dry-run]
      Validates your WAV (PCM, 3-30 s, at most 32 MiB) and converts it to PCM16 mono with ffmpeg only if needed.

Both modes write `<dir>/reference.wav` and print exactly ONE JSON line on stdout:
  {"ok": true, "mode": ..., "file": "reference.wav", "seconds": ..., ...}  or  {"ok": false, "code": ..., "message": ...} (exit 2)
Nothing else goes to stdout, and no message ever contains a path or the input's content.
"""

import argparse
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

DESIGN_MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"
MIN_SECONDS, MAX_SECONDS = 3.0, 30.0
MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
LANGUAGES = {"es": "Spanish", "en": "English", "pt": "Portuguese", "fr": "French", "de": "German", "it": "Italian", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "ru": "Russian"}
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")

_out = sys.stdout
sys.stdout = sys.stderr  # stray prints from libraries must never corrupt the single result line


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def emit(payload):
    _out.write(json.dumps(payload) + "\n")
    _out.flush()


def log(*args):
    print("[speak-design-voice]", *args, file=sys.stderr, flush=True)


def parse_wav(path):
    """Header facts of a WAV file: (format, channels, rate, bits, data_bytes). Raises Fail with a code."""
    with open(path, "rb") as handle:
        head = handle.read(12)
        if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise Fail("not_wav", "The file is not a WAV file")
        size = os.fstat(handle.fileno()).st_size
        fmt = None
        while True:
            chunk = handle.read(8)
            if len(chunk) < 8:
                raise Fail("not_wav", "The WAV has no audio data")
            ident, length = chunk[:4], struct.unpack("<I", chunk[4:])[0]
            if ident == b"fmt " and length >= 16:
                body = handle.read(length)
                if len(body) < 16:
                    raise Fail("not_wav", "The WAV header is truncated")
                code, channels, rate, _, _, bits = struct.unpack("<HHIIHH", body[:16])
                if code == 0xFFFE and length >= 40:
                    code = struct.unpack("<H", body[24:26])[0]
                fmt = (code, channels, rate, bits)
                handle.seek(length % 2, 1)
            elif ident == b"data":
                if fmt is None:
                    raise Fail("not_wav", "The WAV has no format header")
                available = max(0, size - handle.tell())
                return fmt + (min(length, available),)
            else:
                handle.seek(length + (length % 2), 1)


def check(fmt, enforce_duration=True):
    code, channels, rate, bits, data = fmt
    if code != 1:
        raise Fail("not_pcm", "The WAV is not PCM")
    if channels < 1 or bits not in (8, 16, 24, 32) or rate < 8000 or rate > 192000:
        raise Fail("unsupported", "The WAV format is not supported")
    seconds = data / (rate * channels * (bits // 8))
    if seconds < MIN_SECONDS:
        raise Fail("too_short", "The audio is too short (minimum %d s)" % MIN_SECONDS)
    if seconds > MAX_SECONDS:
        raise Fail("too_long", "The audio is too long (maximum %d s)" % MAX_SECONDS)
    return seconds


def write_pcm16(path, pcm, rate):
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(header + pcm)


def prepare_out(out):
    if not out or not os.path.isabs(out):
        raise Fail("bad_out", "The output directory must be an absolute path")
    os.makedirs(out, mode=0o700, exist_ok=True)
    if not os.path.isdir(out):
        raise Fail("bad_out", "The output path is not a directory")
    return os.path.join(out, "reference.wav")


def design(args):
    description, sample = args.description or "", (args.sample or "").strip()
    if not 10 <= len(description.strip()) <= 600 or CONTROL.search(description):
        raise Fail("bad_description", "The description must have 10 to 600 characters and no control characters")
    if not 40 <= len(sample) <= 400 or CONTROL.search(sample):
        raise Fail("bad_sample", "The sample sentence must have 40 to 400 characters and no control characters")
    language = LANGUAGES.get(args.language)
    if language is None:
        raise Fail("bad_language", "Unsupported language")
    target = prepare_out(args.out)
    if args.dry_run:
        rate = 24000
        seconds = max(3.5, min(25.0, len(sample) / 14.0))
        frames = int(rate * seconds)
        pcm = b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * 220 * i / rate))) for i in range(frames))
    else:
        os.environ["HF_HUB_OFFLINE"] = "1"
        try:
            import mlx.core as mx
            import numpy as np
            from mlx_audio.tts.utils import load_model

            model = load_model(DESIGN_MODEL_ID)
            chunks = []
            for result in model.generate_voice_design(text=sample, instruct=description.strip(), language=language, temperature=0.85, stream=True, streaming_interval=1.0):
                chunks.append(result.audio)
                mx.eval(chunks[-1])
            audio = mx.clip(mx.concatenate(chunks), -1.0, 1.0)
            samples = (audio * 32767.0).astype(mx.int16)
            mx.eval(samples)
            pcm = np.asarray(samples).tobytes()
            rate = int(getattr(model, "sample_rate", 24000))
        except Exception as error:  # noqa: BLE001 - the detail stays on stderr; stdout never carries paths
            log("design failed:", repr(error))
            raise Fail("design_failed", "The VoiceDesign model could not run; check that it is downloaded and mlx-audio works")
    seconds = len(pcm) / (rate * 2)
    if seconds < MIN_SECONDS:
        raise Fail("too_short", "The designed audio is too short; use a longer sample sentence")
    if seconds > MAX_SECONDS:
        raise Fail("too_long", "The designed audio is too long; use a shorter sample sentence")
    write_pcm16(target, pcm, rate)
    return {"ok": True, "mode": "design", "file": "reference.wav", "seconds": round(seconds, 3), "rate": rate}


def import_wav(args):
    transcript = (args.transcript or "").strip()
    if not 1 <= len(transcript) <= 500 or CONTROL.search(transcript):
        raise Fail("bad_transcript", "The transcript must have 1 to 500 characters and no control characters")
    source = os.path.abspath(args.wav or "")
    if not os.path.isfile(source):
        raise Fail("not_found", "The WAV file was not found")
    if os.path.getsize(source) > MAX_INPUT_BYTES:
        raise Fail("too_large", "The WAV file is too large (maximum 32 MiB)")
    fmt = parse_wav(source)
    seconds = check(fmt)
    target = prepare_out(args.out)
    code, channels, rate, bits, _ = fmt
    converted = not (channels == 1 and bits == 16)
    if not converted:
        temporary = target + ".tmp"
        try:
            shutil.copyfile(source, temporary)
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
    else:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise Fail("ffmpeg_missing", "ffmpeg is required to convert this WAV to 16-bit mono and was not found")
        temporary = os.path.join(os.path.dirname(target), ".reference.tmp.wav")
        try:
            run = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-map_metadata", "-1", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", temporary], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
            if run.returncode != 0 or not os.path.isfile(temporary) or os.path.getsize(temporary) > MAX_OUTPUT_BYTES:
                raise Fail("convert_failed", "ffmpeg could not convert the WAV")
            seconds = check(parse_wav(temporary))
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        except subprocess.TimeoutExpired:
            raise Fail("convert_failed", "ffmpeg took too long to convert the WAV")
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
    return {"ok": True, "mode": "import", "file": "reference.wav", "seconds": round(seconds, 3), "converted": converted}


def main(argv):
    parser = argparse.ArgumentParser(prog="speak-design-voice", add_help=False)
    sub = parser.add_subparsers(dest="mode")
    d = sub.add_parser("design", add_help=False)
    d.add_argument("--description")
    d.add_argument("--sample")
    d.add_argument("--language", default="es")
    d.add_argument("--out")
    d.add_argument("--dry-run", action="store_true")
    i = sub.add_parser("import", add_help=False)
    i.add_argument("--wav")
    i.add_argument("--transcript")
    i.add_argument("--out")
    i.add_argument("--dry-run", action="store_true")
    try:
        args, extra = parser.parse_known_args(argv)
        if args.mode not in ("design", "import") or extra:
            raise Fail("usage", "Usage: design|import with the documented options")
        emit(design(args) if args.mode == "design" else import_wav(args))
        return 0
    except Fail as failure:
        emit({"ok": False, "code": failure.code, "message": failure.message})
        return 2
    except SystemExit:
        emit({"ok": False, "code": "usage", "message": "Usage: design|import with the documented options"})
        return 2
    except Exception as error:  # noqa: BLE001
        log("unexpected:", repr(error))
        emit({"ok": False, "code": "failed", "message": "The operation failed"})
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
