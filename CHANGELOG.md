# Changelog

## Unreleased

- Added a catalog of seven Qwen3-TTS reference voices (`qwen-*`, model `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16`), a sha256-verified installer into `~/.gentle-speak/voices/qwen3/`, and a rebindable `cycleVoice` key (default `ctrl+alt+n`). Existing settings files stay valid; Piper `es_MX`/`es_ES` and the default voice are unchanged. Engine routing and menus follow separately.
- Qwen voices now speak: a persistent Python synth worker (`scripts/speak-qwen-worker.py`, schema `gentle.speak.qwen/v1`, mlx-audio, offline) streams sentence-group WAV chunks to a new `play` message of the Node audio worker. Piper behaviour and the existing `speak` message are unchanged; a Qwen voice that is not installed is refused with a clear error and nothing is spawned.
- Added the SPEAK status row (state, active voice, configured toggle and cycle keys) in Gentle Shell's INTEGRATIONS section, the `cycleVoice` shortcut that advances to the next installed voice, and a `/speak` voice menu generated from the catalog (label, id, installed state) with a `Key: cycleVoice` rebind. The row is set only in the interactive parent TUI and cleared on shutdown or reload.

## 0.1.0 - 2026-11-08 (local candidate)

- Added opt-in Spanish speech for final questions and usable results, with `all` and model-assisted `summary` modes.
- Added `/speak` configuration, manual `speak` tool, rebindable shortcuts, and explicit verified downloads of separate converted voice and native runtime artifacts.
- Restricted playback to interactive parent TUI sessions; stop, reload, and shutdown discard pending speech.
- Added package metadata and a representative speech illustration for eventual gallery discovery.

Publication is pending independent installer/archive audit and live Pi integration verification. No public repository, gallery listing, or npm release is claimed.
