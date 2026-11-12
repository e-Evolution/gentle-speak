#!/usr/bin/env python3
# Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com
# SPDX-License-Identifier: MIT
# This program is free software: you can redistribute it and/or modify it
# under the terms of the MIT License. See the LICENSE file in the root of
# this project for the full license text.
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# MIT License for more details.
# Email: victor.perez@e-evolution.com, http://www.e-evolution.com , http://github.com/e-Evolution
# Created by victor.perez@e-evolution.com , www.e-evolution.com
"""Persistent Qwen3-TTS synth worker for gentle-speak (schema gentle.speak.qwen/v1).

JSON lines on stdin/stdout; stdout carries protocol lines ONLY, logs go to stderr.

Emits:   ready | chunk {id, seq, wav, seconds} | done {id} | error {id, message} | warning {message}
Accepts: synth {id, text, ref, refText, outDir, speed} | shutdown

Run with `python -I`. Set GENTLE_SPEAK_QWEN_FAKE=1 for a sine-wave engine (tests only);
otherwise the real mlx-audio model is loaded from the local cache (HF_HUB_OFFLINE=1).
"""

import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import wave

SCHEMA = "gentle.speak.qwen/v1"
QWEN_MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
MAX_LINE = 65536
MAX_TEXT = 4000
GROUP_CHARS = 250
FAKE = os.environ.get("GENTLE_SPEAK_QWEN_FAKE") == "1"
FAKE_MODEL = os.environ.get("GENTLE_SPEAK_QWEN_FAKE_MODEL") == "1"
SYNTH_KEYS = {"schema", "type", "id", "text", "ref", "refText", "outDir", "speed"}

_out = sys.stdout
sys.stdout = sys.stderr  # stray prints from libraries must never corrupt the protocol
_warned = False


def send(type_, **fields):
    _out.write(json.dumps({"schema": SCHEMA, "type": type_, **fields}, ensure_ascii=False) + "\n")
    _out.flush()


def log(*args):
    print("[speak-qwen]", *args, file=sys.stderr, flush=True)


def validate(message):
    """Return a synth request dict or raise ValueError with a short reason."""
    if not isinstance(message, dict):
        raise ValueError("request must be an object")
    if message.get("schema") != SCHEMA:
        raise ValueError("bad schema")
    kind = message.get("type")
    if kind == "shutdown":
        if set(message) != {"schema", "type"}:
            raise ValueError("bad shutdown keys")
        return message
    if kind != "synth":
        raise ValueError("unknown type")
    if set(message) != SYNTH_KEYS:
        raise ValueError("bad synth keys")
    ident = message["id"]
    if isinstance(ident, bool) or not isinstance(ident, int) or ident < 0:
        raise ValueError("bad id")
    text = message["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or re.search(r"[\x00-\x08\x0b-\x1f]", text):
        raise ValueError("bad text")
    for key in ("ref", "outDir"):
        value = message[key]
        if not isinstance(value, str) or not os.path.isabs(value) or os.path.normpath(value) != value or len(value) > 4095:
            raise ValueError(f"bad {key}")
    if not isinstance(message["refText"], str) or not message["refText"].strip() or len(message["refText"]) > MAX_TEXT:
        raise ValueError("bad refText")
    speed = message["speed"]
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not math.isfinite(speed) or speed < 0.5 or speed > 2:
        raise ValueError("bad speed")
    if not os.path.isfile(message["ref"]):
        raise ValueError("ref is not a file")
    if not os.path.isdir(message["outDir"]):
        raise ValueError("outDir is not a directory")
    return message


def split_groups(text, limit=GROUP_CHARS):
    """Sentence groups of at most ~limit chars, preserving order."""
    sentences = [s for s in re.split(r"(?<=[.!?…])\s+|\n+", text.strip()) if s.strip()]
    pieces = []
    for sentence in sentences:
        while len(sentence) > limit:
            cut = max(sentence.rfind(sep, 0, limit) for sep in (", ", "; ", ": ", " "))
            cut = cut + 1 if cut > 0 else limit
            pieces.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            pieces.append(sentence)
    groups, current = [], ""
    for piece in pieces:
        if current and len(current) + 1 + len(piece) > limit:
            groups.append(current)
            current = piece
        else:
            current = f"{current} {piece}".strip()
    if current:
        groups.append(current)
    return groups


def atempo_filter(speed):
    """Pitch-preserving atempo chain; each stage stays within 0.5..1.5."""
    stages, rest = [], speed
    while rest > 1.5:
        stages.append(1.5)
        rest /= 1.5
    stages.append(rest)
    return ",".join(f"atempo={s:.6f}" for s in stages)


def write_wav(path, pcm_bytes, rate):
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm_bytes)


def wav_seconds(path):
    with wave.open(path, "rb") as handle:
        return handle.getnframes() / handle.getframerate()


def apply_tempo(path, speed):
    """Return path (possibly rewritten at a new tempo). Warn once when ffmpeg is missing."""
    global _warned
    if abs(speed - 1.0) < 1e-6:
        return
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        if not _warned:
            _warned = True
            send("warning", message="ffmpeg not found; speed is ignored and audio plays at native speed")
        return
    temporary = path + ".tempo.wav"
    run = subprocess.run(
        [ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", path, "-filter:a", atempo_filter(speed), "-ac", "1", "-c:a", "pcm_s16le", temporary],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=False,
    )
    if run.returncode != 0:
        log("ffmpeg failed:", run.stderr.decode("utf-8", "replace")[:300])
        if os.path.exists(temporary):
            os.remove(temporary)
        return
    os.replace(temporary, path)


class FakeEngine:
    rate = 24000

    def synthesize(self, group, ref, ref_text):
        frames = int(self.rate * 0.25)
        data = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / self.rate))) for i in range(frames))
        yield data, self.rate


class QwenEngine:
    def __init__(self, model=None):
        if model is None:
            os.environ["HF_HUB_OFFLINE"] = "1"
            import mlx.core as mx
            import numpy as np
            from mlx_audio.tts.utils import load_model

            self.mx, self.np = mx, np
            model = load_model(QWEN_MODEL_ID)
        self.model = model
        self.rate = getattr(model, "sample_rate", 24000)

    def to_pcm(self, audios):
        mx, np = self.mx, self.np
        pcm = (mx.clip(mx.concatenate(audios), -1.0, 1.0) * 32767.0).astype(mx.int16)
        mx.eval(pcm)
        return np.asarray(pcm).tobytes()

    def synthesize(self, group, ref, ref_text):
        produced = False
        for result in self.model.generate(text=group, ref_audio=ref, ref_text=ref_text, language="Spanish", stream=True):
            produced = True
            yield self.to_pcm([result.audio]), self.rate  # one part at a time: the caller sends it at once
        if not produced:
            raise RuntimeError("model produced no audio")


class _FakePart:
    def __init__(self, audio):
        self.audio = audio


class FakeModel:
    """Test-only stand-in for the mlx-audio model: N streamed parts, a delay before each."""

    sample_rate = 24000

    def __init__(self, parts, delay):
        self.parts, self.delay = parts, delay

    def generate(self, text, ref_audio, ref_text, language, stream):
        for index in range(self.parts):
            time.sleep(self.delay)
            yield _FakePart([0.25 * math.sin(2 * math.pi * 440 * (index * 4800 + i) / self.sample_rate) for i in range(4800)])


class FakeModelEngine(QwenEngine):
    """QwenEngine's real streaming code path over FakeModel; pure Python PCM16 (GENTLE_SPEAK_QWEN_FAKE_MODEL=1, tests only)."""

    def __init__(self):
        super().__init__(FakeModel(int(os.environ.get("GENTLE_SPEAK_QWEN_FAKE_PARTS", "3")), float(os.environ.get("GENTLE_SPEAK_QWEN_FAKE_DELAY", "0.2"))))

    def to_pcm(self, audios):
        return b"".join(struct.pack("<h", int(max(-1.0, min(1.0, x)) * 32767.0)) for audio in audios for x in audio)


def handle_synth(engine, request):
    ident, out_dir = request["id"], request["outDir"]
    seq = 0
    for group in split_groups(request["text"]):
        for pcm, rate in engine.synthesize(group, request["ref"], request["refText"]):
            path = os.path.join(out_dir, f"chunk-{ident}-{seq}.wav")
            write_wav(path, pcm, rate)
            apply_tempo(path, float(request["speed"]))
            send("chunk", id=ident, seq=seq, wav=path, seconds=round(wav_seconds(path), 3))
            seq += 1
    if seq == 0:
        raise RuntimeError("nothing to synthesize")
    send("done", id=ident)


def main():
    try:
        engine = FakeEngine() if FAKE else FakeModelEngine() if FAKE_MODEL else QwenEngine()
    except Exception as error:  # noqa: BLE001 - report and exit; the parent shows a clear failure
        log("model load failed:", repr(error))
        send("error", id=None, message="model load failed")
        return 1
    send("ready")
    for line in sys.stdin:
        ident = None
        try:
            if len(line) > MAX_LINE:
                raise ValueError("line too long")
            message = json.loads(line)
            if isinstance(message, dict) and isinstance(message.get("id"), int) and not isinstance(message.get("id"), bool):
                ident = message["id"]
            request = validate(message)
            if request["type"] == "shutdown":
                return 0
            handle_synth(engine, request)
        except Exception as error:  # noqa: BLE001 - one bad request must not kill the worker
            log("request failed:", repr(error))
            send("error", id=ident, message=str(error) if isinstance(error, ValueError) else "synthesis failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
