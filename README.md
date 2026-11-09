# gentle-speak

Opt-in local text-to-speech for Pi / Gentle Shell. This README is the package instruction page, not a claim that the extension is published or independently audited. [Preview](assets/preview.png) is a speech illustration, **not** a UI screenshot.

## Install and use

Requires Node.js 24+ and a supported interactive parent TUI session. For local use from this checkout, run `npm ci`, then `pi install ./` and `/reload` in Pi. The package declares `pi.extensions` as `./extensions/gentle-speak.ts`; it does not install voices or native audio at startup. Automatic speech starts **off**. No public npm package or Gentle Hub listing is claimed yet.

Run `/speak` to select **Install voice and runtime**. Confirm the voice download and the native runtime download **separately**; neither happens without consent. The default voice is Spanish (Mexico, `es_MX`); Spanish (Spain, `es_ES`) is also available. These are separate converted Piper TTS bundles, not the Parakeet dictation model. Invalid existing artifacts are not silently replaced. Then use `/speak` → **Toggle auto-speak** to enable automatic playback. Default `questions-and-results` reads eligible final questions and usable results; `all` reads other final prose too. Code blocks, diffs, and tool output are excluded. Use `/speak` to change mode, voice and speed (0.5–2).

For `summary` mode choose `/speak` → **Summary model** and select an available authenticated Pi model. The selected provider may use the network and incur its normal costs; only sanitized final assistant prose is sent, not tool output. With no selected model, summary speech is unavailable. The model-callable `speak` tool and speak-last shortcut allow deliberate playback even when auto-speak is off, after installation.

Default shortcuts: `ctrl+alt+v` speaks the last assistant message, `ctrl+alt+.` stops playback, and `ctrl+alt+m` toggles automatic speech. Rebind under `/speak` → **Key: speakLast**, **Key: stop**, or **Key: toggle**; run `/reload` to register new keys. Pi and Gentle Shell reserved keys and duplicate bindings are rejected. `/reload` and session shutdown stop playback and drop queued speech. Settings live at `~/.gentle-speak/speak-settings.json`; missing or malformed settings mean off. RPC, print, JSON, and delegated child sessions never speak.

## Platform, licenses and verification

Supported runtime targets: macOS x64/arm64, Linux x64/arm64 (glibc ≥2.34 for native binaries), Windows x64; other platforms are unsupported. The extension installs its own sherpa-onnx-node / node-cpal runtime, independently of Gentle Shell dictation. Converted voice bundles come from [sherpa-onnx TTS model releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models); retain each installed model's `MODEL_CARD` and check dataset/voice rights before redistribution. The es_MX Claude model card identifies Apache-2.0 dataset attribution; es_ES Davefx identifies CC0. Repository code is [MIT](LICENSE); sherpa-onnx-node/platform binaries are Apache-2.0, bundled onnxruntime MIT, and node-cpal ISC with Rust dependencies. Runtime tarballs do not contain all bundled LICENSE/NOTICE texts; resolve notices before distributing a combined runtime.

Local macOS arm64 tests returned worker `done` for both voices without protocol errors; physical audibility and other platforms have **not** been verified. Independent archive/installer audit timed out without a verdict, and live Pi registration/event/shortcut/provider integration remains unverified. Do not treat this package as publication-ready until those checks pass. No public repository topics, PR, npm publish, or Hub listing are claimed.

## Development

Run `npm test` with Node.js 24+. See [CHANGELOG.md](CHANGELOG.md) for the local candidate history.
