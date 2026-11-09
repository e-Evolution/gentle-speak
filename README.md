# gentle-speak

Opt-in local text-to-speech for Pi / Gentle Shell. This README is the package instruction page, not a claim that the extension is published or independently audited. [Preview](assets/preview.png) is a speech illustration, **not** a UI screenshot.

## Install and use

Requires Node.js 24+, Pi, and a supported interactive parent TUI session. **Automatic speech is off by default.** Installing the package does not install voice models or start native audio.

### From this checkout (available now)

```bash
cd /path/to/gentle-speak
npm ci
pi install ./
pi
```

Pi loads local packages in place; `npm ci` supplies the package's `seek-bzip` dependency. If Pi is already running, use `/reload` after `pi install ./`. To remove this local installation later, run `pi remove ./` from the same directory. There is no published npm package or Gentle Hub listing yet.

### From GitHub (only after this repository is public and verified)

```bash
pi install git:github.com/e-Evolution/gentle-speak
pi
```

This Git command is **not available yet** and follows the repository's current default branch; pin a release tag (`@<tag>`) once one actually exists. Git-backed packages install their declared dependencies automatically. Do not use `npm install gentle-speak` until an npm release exists.

### First playback

1. In Pi's interactive parent TUI, run `/speak` → **Install voice and runtime**. Confirm the converted voice bundle (about 67 MB) and native runtime download **separately**; declining either performs no download for that artifact.
2. Choose `es_MX` (default) or `es_ES` under `/speak`. They are separate converted Piper TTS bundles, not the Parakeet dictation model. Invalid artifacts are never silently replaced.
3. Use `/speak` → **Toggle auto-speak**. The default `questions-and-results` mode reads eligible final questions and usable results; `all` reads other final prose. Code blocks, diffs, and tool output are excluded. `/speak` also changes speed (0.5–2).

Manual speech uses the `speak` tool or the speak-last shortcut after installation, even when automatic speech is off.

For `summary` mode choose `/speak` → **Summary model** and select an available authenticated Pi model. The selected provider may use the network and incur its normal costs; only sanitized final assistant prose is sent, not tool output. With no selected model, summary speech is unavailable.

Default shortcuts: `ctrl+alt+v` speaks the last assistant message, `ctrl+alt+.` stops playback, and `ctrl+alt+m` toggles automatic speech. Rebind under `/speak` → **Key: speakLast**, **Key: stop**, or **Key: toggle**; run `/reload` to register new keys. Pi and Gentle Shell reserved keys and duplicate bindings are rejected. `/reload` and session shutdown stop playback and drop queued speech. Settings live at `~/.gentle-speak/speak-settings.json`; missing or malformed settings mean off. RPC, print, JSON, and delegated child sessions never speak.

## Platform, licenses and verification

Supported runtime targets: macOS x64/arm64, Linux x64/arm64 (glibc ≥2.34 for native binaries), Windows x64; other platforms are unsupported. The extension installs its own sherpa-onnx-node / node-cpal runtime, independently of Gentle Shell dictation. Converted voice bundles come from [sherpa-onnx TTS model releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models); retain each installed model's `MODEL_CARD` and check dataset/voice rights before redistribution. The es_MX Claude model card identifies Apache-2.0 dataset attribution; es_ES Davefx identifies CC0. Repository code is [MIT](LICENSE); sherpa-onnx-node/platform binaries are Apache-2.0, bundled onnxruntime MIT, and node-cpal ISC with Rust dependencies. Runtime tarballs do not contain all bundled LICENSE/NOTICE texts; resolve notices before distributing a combined runtime.

Local macOS arm64 tests returned worker `done` for both voices without protocol errors; physical audibility and other platforms have **not** been verified. Independent archive/installer audit timed out without a verdict, and live Pi registration/event/shortcut/provider integration remains unverified. Do not treat this package as publication-ready until those checks pass. No public repository topics, PR, npm publish, or Hub listing are claimed.

## Development

Run `npm test` with Node.js 24+. See [CHANGELOG.md](CHANGELOG.md) for the local candidate history.
