# gentle-speak

A planned local text-to-speech extension for Pi / Gentle Shell. **Speech and controls are not yet implemented.** This initial package only exports an inert Pi extension: installing or loading it does not download a model, start a worker, or play audio.

## Status

Not yet implemented: automatic reading of questions and usable results, `/speak` settings, keyboard shortcuts, model-callable speech, local TTS runtime, and configurable Spanish `es_MX` / `es_ES` voices. The planned default is off; the independent speech runtime will require an explicit installation flow. Do not install this version expecting audio playback.

The standalone settings module (`lib/speak-settings.ts`) validates a versioned JSON file, defaults to off when missing or malformed, and supports Spanish `es_MX` / `es_ES` voices, mode, playback speed (0.5–2), and rebindable shortcuts. It does not start audio or download anything. The `/speak` command is not implemented yet.

The pure `lib/speak-filter.ts` API accepts settled-run messages and returns final assistant prose (or `undefined`). It defaults to questions and usable results; `all` includes other final prose, while `summary` returns no text until the T6 model-generated summary is integrated. Fenced and inline code, diff lines, and tool output are excluded. This heuristic is conservative and does not yet play audio.

`lib/speak-install.ts` provides opt-in installers for pinned Piper `es_MX` (Claude high) and `es_ES` (Davefx medium) models and an independent sherpa-onnx-node 1.13.8 + platform binary + node-cpal 1.0.0 runtime. The caller must obtain explicit consent and pass `confirmed: true` for each request; importing the module or starting Pi downloads nothing. Model files are verified by exact size and SHA-256, including on subsequent status reads. Runtime npm tarballs are verified by exact size and pinned SHA-512 before bounded extraction; only regular files with safe paths are accepted. Both publish complete payloads from private staging. Supported targets are macOS x64/arm64, Linux x64/arm64 (native binaries require glibc >=2.34), and Windows x64; node-cpal requires Node >=22 (this package requires >=24). An invalid existing install is never silently replaced. No native code is loaded or audio played here; worker playback and UI integration remain pending. Redirects for model downloads are limited to the pinned Hugging Face resolve-cache and observed US Xet CDN origin; other regional CDN destinations fail closed until independently verified.

Model sources: [Piper voices](https://huggingface.co/rhasspy/piper-voices) at commit `e7229f7d33a10e145e109b886d661984201ac3c4`. The repository is MIT-licensed; the per-voice model cards identify the es_MX Claude dataset as Apache-2.0 and es_ES Davefx as CC0. Check each model card and its dataset attribution independently before redistribution; the repository license alone does not determine dataset or voice rights. The future runtime dependencies also have independent obligations: sherpa-onnx-node and its platform binaries are Apache-2.0 (bundled onnxruntime is MIT); node-cpal is ISC and bundles Rust dependencies. The npm tarballs do not include complete LICENSE/NOTICE texts for all bundled dependencies; resolve those notices before shipping a combined runtime.

The gallery preview declared in package metadata is pending and will be added before publication. The changelog and public repository topics are also pending.

## Development

Requires Node.js 24 or later. Run `npm test` (or `node --experimental-strip-types --test tests/*.test.ts`) for the package scaffold checks. No install or download is needed for these tests.

## License

MIT; see [LICENSE](LICENSE).
