---
title: Installation
nav_order: 2
translation: es/instalacion.md
---

# Installation
{: .no_toc }

1. TOC
{:toc}

---

## Requirements

You provide:

- **Gentle Shell (Pi)** and **Node.js 24 or newer**.
- **For Qwen voices:** macOS on Apple Silicon, and `uv` **or** Python 3.12 or newer. Without either, setup tells you how to install one (for example `brew install python@3.12` or `brew install uv`) and installs nothing of the system for you.
- **Optional:** `ffmpeg`, used only to change the speed of Qwen voices. Setup detects it and shows an install hint (`brew install ffmpeg` on macOS). It never installs system packages.
- **Linux system voice:** `sudo apt install speech-dispatcher espeak-ng`. macOS and Windows need nothing extra for the system voice.

Everything else is downloaded by the setup, after you confirm it. See [What setup installs](#what-setup-installs).

## Install the package

Pick one source.

### From npm (once published)

The package is not on npm yet. Once it is published:

```bash
gentle-shell install npm:@e-evolution/gentle-speak
```

### From GitHub

```bash
gentle-shell install git:github.com/e-Evolution/gentle-speak
```

Pi documents git sources as `git:<host>/<owner>/<repo>` with an optional `@<ref>` suffix (a tag or a branch), and also the `https://<host>/<owner>/<repo>` form. For example, to pin a tag:

```bash
gentle-shell install git:github.com/e-Evolution/gentle-speak@<tag>
```

### From a local checkout

```bash
git clone https://github.com/e-Evolution/gentle-speak.git
cd gentle-speak && npm ci
gentle-shell install ./
```

### Try it without installing

From a checkout, you can load the extension for one session only:

```bash
gentle-shell -- -e ./extensions/gentle-speak.ts
```

## Restart Gentle Shell

If Gentle Shell was already open, restart it with:

```bash
gentle-shell -r
```

`gentle-shell -r` resumes a session with the Gentle Shell package loaded; `gentle-shell -c` continues the last one. Plain `pi` starts vanilla Pi with its own home (`~/.pi`), not Gentle Shell's.

Do not use `/reload` for this: it can crash Gentle Shell 4.7.0 (gentle-shell#2580). That is a Gentle Shell issue, not a gentle-speak one.

## First-start setup

Pi installs packages without running install scripts, so gentle-speak sets itself up on the **first terminal start**. Nothing reaches the network before you confirm.

1. gentle-speak shows **one confirmation**, titled «Instalar todo», that lists what is missing, the size of each part and the total. The sizes are pinned values, not looked up online.
2. If you accept, it installs the parts one by one in the background, with progress notices. A failure stops only that part; the others still install, except the Qwen model, which needs the Python environment. It ends with «gentle-speak listo» when everything installed, or with «gentle-speak: instalación incompleta.» and a ✓ / ✗ / – line per part.
3. If you decline, the decline is remembered (`setupOffer: "declined"` in the settings file) and you are not asked again at start.

You can run the same setup at any time with `/speak` → **Instalar todo**. When nothing is missing, it says so.

On Apple Silicon, when Qwen is ready and you have no voice of your own yet, setup suggests `/speak` → «Crear voz propia…». See [Voices](voices.md).

### What setup installs

| Part | Size | Where |
|------|------|-------|
| Native audio runtime (sherpa-onnx + node-cpal) | about 18 MB | `~/.gentle-speak/runtime/` |
| Piper `es_MX` voice | about 67 MB | `~/.gentle-speak/models/` |
| Python environment with `mlx-audio==0.4.4` and its hash-locked dependencies (Apple Silicon only) | about 480 MB on disk | `~/.gentle-speak/python/` |
| Qwen3-TTS Base 0.6B model (Apple Silicon only) | about 2.5 GB | Hugging Face cache (`HF_HOME`, default `~/.cache/huggingface`) |

Notes:

- The runtime size depends on your platform; the confirmation shows the exact pinned size.
- The Python environment is created with `uv`, or else `python3 -m venv`. It needs no `sudo` and leaves your system Python untouched.
- The **VoiceDesign 1.7B** model (about 4.5 GB) is **never** part of setup. It downloads only if you choose «Crear voz propia…» and confirm that download.
- The Spanish (Spain) Piper voice, `es_ES`, is optional. Select it as your voice, then use `/speak` → **Install voice and runtime**.
- Each download is verified. The runtime packages and the Piper bundles have pinned hashes, and the Python packages are installed with `--require-hashes`.

For where each download comes from, see [Privacy and security](privacy.md).

## Check the installation

Run:

```text
/speak doctor
```

It runs 14 read-only checks and marks each one ✓ (ok), ✗ (problem, with a fix hint) or – (does not apply, or optional). It ends by offering a spoken test. See [Troubleshooting](troubleshooting.md).

## Turn speech on

Automatic speech is off by default. Turn it on with `ctrl+alt+m`, or `/speak` → **Toggle auto-speak**. See [Usage](usage.md).

## Where files go

gentle-speak's own files live in `~/.gentle-speak/`. The Qwen models live in the Hugging Face cache, and pip or uv keep their usual download caches. See [Architecture](architecture.md#the-gentle-speak-folder) for the full layout.
