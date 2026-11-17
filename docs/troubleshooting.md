---
title: Troubleshooting
nav_order: 9
---

# Troubleshooting
{: .no_toc }

1. TOC
{:toc}

---

## Start with `/speak doctor`

Run `/speak doctor`, or `/speak` → **Doctor**. It runs 14 checks and prints one line per check:

- ✓ ok;
- ✗ a problem, with a fix hint (→) on the next line;
- – does not apply here, or is optional.

Every check is read-only: nothing is written, installed, started or downloaded. Each check has a time limit (8 seconds), and a check that hangs or fails is reported as ✗ without hiding the others. The report ends with a summary line, then the doctor offers to speak a test sentence («¿Probar una frase?»).

The report is in Spanish, like the `/speak` menu. The labels below are the ones you see.

| Check | What it looks at | Typical fix |
|-------|------------------|-------------|
| **Runtime de audio** | The native audio runtime is installed and verified | `/speak` → «Instalar todo». If it is invalid, delete `~/.gentle-speak/runtime` and run «Instalar todo» |
| **Salida de audio** | The default output device opens, with a silent stream (no sound). Needs the runtime | Check the system output device (Bluetooth connected, volume) |
| **Modelos Piper** | The `es_MX` voice (required) and `es_ES` (optional) | «Instalar todo» |
| **Entorno Python + mlx-audio** | Apple Silicon only. The recorded Python environment exists, imports `mlx_audio`, and was installed with the current hash-locked dependencies | «Instalar todo». It needs `uv` or Python 3.12+ (`brew install python@3.12`) |
| **Modelo Qwen Base 0.6B (caché)** | Apple Silicon only. The Base model is in the Hugging Face cache | «Instalar todo» |
| **Modelo VoiceDesign (opcional)** | Apple Silicon only. The VoiceDesign model is in the cache. Optional: – when missing | Downloaded when you use «Crear voz propia…» |
| **Voces propias (sha256)** | Your own voices, each checked against its sha256 | Delete an invalid one with «Borrar voz propia…» and create or import it again |
| **Voz elegida** | The selected voice can be used | Choose another voice with `/speak`, or run «Instalar todo» |
| **Servicio Qwen compartido** | Apple Silicon only. The shared service's socket, pid, version and build, read without connecting to it | A stale socket is fixed by the next Qwen use; or «Detener servicio Qwen» |
| **Cerrojo de voz** | The voice lock: free, held by a live process, or left by a dead one (reclaimed on the next speech) | Nothing to do |
| **ffmpeg** | `ffmpeg` is on `PATH` (needed only to change the speed of Qwen voices) | `brew install ffmpeg` on macOS, `winget install ffmpeg` on Windows, `sudo apt install ffmpeg` on Linux |
| **Voz del sistema** | The platform's system voice engine and its Spanish voices | macOS: add a Spanish voice in System Settings → Accessibility → Spoken Content. Linux: `sudo apt install speech-dispatcher espeak-ng`. Windows: add a Spanish language in Settings → Time & Language → Speech |
| **Fuente de foco** | Where focus comes from: terminal focus events, Herdr, or unknown (–) | Inside tmux, `set -g focus-events on` |
| **Conexión con Gentle Dot** | Dot is not installed (–), installed but not connected (–), connected (✓), or its `settings.json` is malformed (✗) | Fix a malformed file by hand; gentle-speak never touches it |

The Qwen checks show – on anything other than macOS on Apple Silicon.

## Common problems

### Nothing is spoken

- Automatic speech is off by default. Turn it on with `ctrl+alt+m` or `/speak` → **Toggle auto-speak**, and check the SPEAK row.
- In `questions-and-results` mode, plain narration is skipped on purpose. Try `/speak` → **Mode: all**.
- In `summary` mode, nothing is spoken until you choose a model with `/speak` → **Summary model**. The SPEAK row then shows `modo resumen sin modelo`.
- Turns that call tools are never spoken, and neither are code blocks, diffs or tool output.

### No sound when the pane is not focused

That is the focus deferral: the latest result is kept until you focus the pane. If focus is unknown, sessions speak in turn, with the project name first. See [Focus](usage.md#focus-with-several-panes).

### «Qwen synthesis failed»

Usually a stale shared service. A service built from different code is now replaced automatically. Otherwise:

1. Run `/speak` → **Detener servicio Qwen** and speak again.
2. If it persists, check with `/speak doctor` that mlx-audio and the Base model are installed.
3. Read `~/.gentle-speak/qwen-service.log`.

### Bluetooth headsets

Playback uses the device's own sample rate and tolerates the buffer underruns (xruns) Bluetooth can produce. You may still hear small glitches. A failure reports `Audio playback failed: <cause>`.

### `/reload` crashes Gentle Shell

That is a Gentle Shell issue (gentle-shell#2580 on 4.7.0), not a gentle-speak one. Restart with `pi -r` instead, also after installing the package or changing a key.

### The Python environment is reported as outdated

An environment installed by an earlier release, without the current hash-locked dependencies, is reported by the doctor and offered again in «Instalar todo». The locked packages are installed into the same environment.

### Setup says it cannot install the Python environment

It needs `uv` or Python 3.12 or newer, and gentle-speak never installs system packages. Install one of them (for example `brew install python@3.12` or `brew install uv`) and run `/speak` → «Instalar todo» again.

### Linux or Windows system voice is silent

Install the tools listed in [Platforms](platforms.md#platform-notes). These paths are not verified live. On Windows, the voice needs `powershell.exe` on `PATH`; the doctor reports «falta `powershell.exe` en el PATH» otherwise.

### Linux `spd-say` keeps talking after stop

Stop (and a timeout) kills `spd-say` and then runs `spd-say -C`, which cancels everything speech-dispatcher has queued, including other applications' speech. Not verified live.

### Copy speech does nothing

It works only on macOS, in the fullscreen TUI, and only for text you select and copy in this Gentle Shell while the terminal is the frontmost app. You see a warning such as «Speak copied selection is unavailable in this terminal mode (fullscreen required).» when it cannot run.

## Logs

| File | What it holds |
|------|---------------|
| `~/.gentle-speak/qwen-service.log` | The shared Qwen service's log, including its version and build at start |
| `~/.gentle-speak/focus.log` | A note when terminal focus events are unavailable |

Clipboard text is never logged.

## Still stuck?

Open an issue on [GitHub](https://github.com/e-Evolution/gentle-speak/issues) with the `/speak doctor` output, your platform and what you expected. For a security problem, follow the [security policy](contributing.md#report-a-vulnerability) instead.
