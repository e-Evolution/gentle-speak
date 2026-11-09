# Changelog

## Unreleased

- Added a catalog of seven Qwen3-TTS reference voices (`qwen-*`, model `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16`), a sha256-verified installer into `~/.gentle-speak/voices/qwen3/`, and a rebindable `cycleVoice` key (default `ctrl+alt+n`). Existing settings files stay valid; Piper `es_MX`/`es_ES` and the default voice are unchanged. Engine routing and menus follow separately.
- Qwen voices now speak: a persistent Python synth worker (`scripts/speak-qwen-worker.py`, schema `gentle.speak.qwen/v1`, mlx-audio, offline) streams sentence-group WAV chunks to a new `play` message of the Node audio worker. Piper behaviour and the existing `speak` message are unchanged; a Qwen voice that is not installed is refused with a clear error and nothing is spawned.
- Added the SPEAK status row (state, active voice, configured toggle and cycle keys) in Gentle Shell's INTEGRATIONS section, the `cycleVoice` shortcut that advances to the next installed voice, and a `/speak` voice menu generated from the catalog (label, id, installed state) with a `Key: cycleVoice` rebind. The row is set only in the interactive parent TUI and cleared on shutdown or reload.
- Qwen speech: the utterance timeout no longer counts playback; readiness (180 s) and a per-event synthesis idle timeout (120 s) replace it, a failed Qwen worker spawn is reported cleanly, and every Qwen failure path is now covered by tests.
- Added an opt-in `copySpeech` setting (default off, existing settings files stay valid) and a `/speak` entry `Toggle speak copied selection`: text you select and copy in this Gentle Shell is spoken with the current voice. macOS and the fullscreen TUI are required; copies in other apps or panes, and concealed/password copies, are skipped. The SPEAK row shows `· copia` while it is on.
- Playback now opens the output device's own default config and resamples in-process, so it never asks the device to change its sample rate (fixes `Sample rate update timed out` on Bluetooth headsets whose rate differs from the voice). A playback failure now reports its cause: `Audio playback failed: <cause>.` (bounded to 120 characters, no paths).
- Qwen replay: late `chunk`/`done`/`error` messages of a cancelled or superseded request are ignored, so replaying while a Qwen utterance is running speaks the new text instead of failing with `Invalid Qwen worker response.`; messages with never-issued ids are still rejected.
- Several sessions: one cross-process voice lock under `~/.gentle-speak/` so sessions never overlap; automatic speech and the `speak` tool speak at once only when the pane is focused (terminal frontmost + Herdr), otherwise keep the latest result until focus, and when focus is unknown speak in turn prefixed with the project name. Hardening: `HERDR_BIN_PATH` must be an absolute `.../herdr`, lock release/reclaim re-verify the owner after the rename, and a refused device default config falls back to the supported-config search once.
- Playback no longer aborts on non-fatal stream errors (buffer underrun/overrun, device rerouted, real-time scheduling refused): it plays to the end, bounded by the utterance timeout and a 50-glitch cap; other stream errors still fail with their cause.

## 0.1.0 - 2026-11-08 (local candidate)

- Added opt-in Spanish speech for final questions and usable results, with `all` and model-assisted `summary` modes.
- Added `/speak` configuration, manual `speak` tool, rebindable shortcuts, and explicit verified downloads of separate converted voice and native runtime artifacts.
- Restricted playback to interactive parent TUI sessions; stop, reload, and shutdown discard pending speech.
- Added package metadata and a representative speech illustration for eventual gallery discovery.

Publication is pending independent installer/archive audit and live Pi integration verification. No public repository, gallery listing, or npm release is claimed.
- The SPEAK row now always shows the copy-speech state with its key (`· copia ○ ctrl+alt+c` / `· copia ●`), and a new rebindable `toggleCopy` key (default `ctrl+alt+c`, `/speak` → `Key: toggleCopy`) toggles it through the same path as `/speak` → `Toggle speak copied selection`. Existing settings files without `toggleCopy` still load with a free default.
