# Changelog

## 0.1.0 - 2026-11-17

First public release.

### Features

- Opt-in automatic speech. When an agent run settles, the final assistant prose is spoken in one of three modes: `questions-and-results` (default), `all`, or `summary` (one short Spanish sentence written by a model you choose). Code blocks, diffs, tool output and turns that call tools are never spoken. Automatic speech is off until you turn it on.
- A model-callable `speak` tool and rebindable keys: speak the last message (`ctrl+alt+v`), stop (`ctrl+alt+.`), toggle auto-speech (`ctrl+alt+m`), next voice (`ctrl+alt+n`) and toggle copy speech (`ctrl+alt+c`). Keys reserved by Pi or Gentle Shell, and duplicates, are refused.
- `/speak` configures auto-speech, mode, voice, speed and keys. Settings live in a validated JSON file; a missing or malformed file means off.
- Three kinds of voices:
  - Piper `es_MX` (default) and `es_ES` through sherpa-onnx;
  - Qwen3-TTS voices cloned from your own recording («Importar mi grabación…», with explicit consent) or designed from a text description («Crear voz propia…»);
  - the system voice (`say` on macOS, `spd-say` or `espeak-ng` on Linux, SAPI on Windows), as an extra voice and as an automatic fallback.
- A one-confirmation first-start setup («Instalar todo») lists what is missing with its size and installs it in the background. `/speak doctor` runs read-only checks with fix hints.
- One shared local Qwen service per user keeps the model loaded while any session is open, unloads it after a configurable grace period (`qwenIdleMinutes`, default 10 minutes), and is replaced automatically when its code changes. Completed sentences are synthesized ahead while the answer streams, so Qwen audio starts sooner.
- Sessions take turns through a cross-process voice lock, so voices never overlap. While your pane is unfocused, only the latest result is kept and spoken when you come back. Focus comes from the terminal's focus reports, Herdr or the frontmost app.
- Gentle Dot support with its own settings, connected from `/speak` → Gentle Dot.
- A SPEAK status row in Gentle Shell's INTEGRATIONS section.
- Opt-in copy speech: text you select and copy in this Gentle Shell is spoken (macOS, fullscreen TUI).
- Playback uses the output device's own sample rate and tolerates Bluetooth buffer glitches; a failure reports its cause.

### Security

- Nothing downloads, loads or starts at Pi startup. RPC, print, JSON and delegated child sessions never speak. Reload and shutdown stop audio and drop pending speech.
- Every download is explicit and confirmed. The native runtime and Piper bundles are verified against pinned sha256 hashes, and the Python environment installs a hash-locked set of PyPI packages (`scripts/requirements-qwen.txt`, `--require-hashes`).
- No network request happens before the setup confirmation: the sizes it shows are pinned approximate values.
- Every child that installs, downloads or runs Python or the Qwen service starts in `~/.gentle-speak` or a private temporary directory, never in your project. `uv` runs with `--no-config`, Python runs isolated (`-I`), and relative `PATH` entries are ignored, so a project's files cannot change what is installed.
- The Qwen service listens on a private unix socket (0600 in a 0700 directory) and accepts only verified voice references under `~/.gentle-speak/voices/custom/`.
- The system voice receives text on stdin, never in arguments. Clipboard text is never stored or logged, and concealed or password-manager copies are skipped.
- Everything runs locally. Only `summary` mode sends sanitized final prose, never tool output, to the model you choose.

### Platforms

- CI runs the test suite on macOS, Linux and Windows.
- Live checks were done on macOS Apple Silicon only. The Linux and Windows speech paths (`spd-say`, `espeak-ng`, SAPI) are verified with fakes only, and Intel macOS is untested.
- Qwen3-TTS needs macOS on Apple Silicon. Copy speech needs macOS. Linux native binaries need glibc ≥ 2.34.
- Requires Gentle Shell (Pi) and Node.js ≥ 24.

### Documentation

- The README doubles as the Gentle Hub instruction page. Install from GitHub with `gentle-shell install git:github.com/e-Evolution/gentle-speak`; the npm package will be `@e-evolution/gentle-speak`.
- A user manual on GitHub Pages: https://e-evolution.github.io/gentle-speak/ (installation, usage, voices, configuration, Gentle Dot, architecture, platforms, troubleshooting, privacy and licenses).
- The manual is also available in Spanish, at https://e-evolution.github.io/gentle-speak/es/, with an English / Español switch on every page.
- After installing, restart Gentle Shell (for example `gentle-shell -r` to resume your session). `/reload` can crash Gentle Shell 4.7.0 (gentle-shell#2580).
- MIT license. THIRD_PARTY_NOTICES.md records every component's license, including the GPL-3.0 note for espeak-ng inside the sherpa-onnx runtime that users download.
