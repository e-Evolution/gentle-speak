# Third-party notices

gentle-speak is MIT-licensed (see [LICENSE](LICENSE)), Copyright (c) 2026 e-Evolution Consultants S.A. This file records the license of every component it uses, how each one relates to the package, and what is still unverified. Licenses below come from the components' own metadata, model cards and upstream documentation as of 2026-11-11; the upstream license files are the authority.

## What gentle-speak does not redistribute

gentle-speak does not redistribute any third-party runtime, binary, voice, model or tool. The published package contains only gentle-speak's own MIT code and a normal npm dependency (`seek-bzip`). Everything else is either:

- **downloaded by you** from the upstream source, after your confirmation, into `~/.gentle-speak/` or the Hugging Face cache; or
- an **external process** already on your system, started as a separate program; or
- a **peer** provided by Gentle Shell (Pi).

No Qwen or Piper voice, model weight, sherpa-onnx or onnxruntime binary, `espeak-ng-data`, or personal reference voice is shipped in this repository or its npm package.

Relation legend: **shipped** = in the package; **peer** = provided by Gentle Shell; **downloaded** = fetched by the user at setup from upstream; **external** = a separate process on the user's machine.

## Components

| # | Component | Version | License | Source | Relation |
|---|-----------|---------|---------|--------|----------|
| 1 | seek-bzip | 2.0.0 (pinned) | MIT | https://www.npmjs.com/package/seek-bzip | shipped (npm dependency) |
| 2 | @earendil-works/pi-coding-agent | `*` (peer) | MIT | https://www.npmjs.com/package/@earendil-works/pi-coding-agent | peer |
| 3 | @earendil-works/pi-tui | `*` (peer) | MIT | https://www.npmjs.com/package/@earendil-works/pi-tui | peer |
| 4 | Gentle Shell (gentle-pi), by Alan Buscaglia | host | MIT, Copyright (c) 2025 Mario Zechner | https://www.npmjs.com/package/gentle-pi | peer (the host application) |
| 5 | sherpa-onnx-node and its platform binaries (e.g. sherpa-onnx-darwin-arm64) | 1.13.8 (pinned) | Apache-2.0 | https://github.com/k2-fsa/sherpa-onnx | downloaded (npm registry tarballs, hash-verified) |
| 6 | onnxruntime (bundled inside the sherpa-onnx binaries) | as bundled by sherpa-onnx 1.13.8 | MIT (**unverified**: license file not checked) | https://github.com/microsoft/onnxruntime | downloaded |
| 7 | node-cpal | 1.0.0 (pinned) | ISC (its Rust crates **unverified**) | https://github.com/saeta-eth/node-cpal | downloaded |
| 8 | Piper voice `es_MX` claude-high (converted bundle `vits-piper-es_MX-claude-high`) | pinned archive | Dataset Apache-2.0 (per the bundle's own `MODEL_CARD`, dataset https://huggingface.co/spaces/HirCoir/Piper-TTS-Spanish) | https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models | downloaded |
| 9 | Piper voice `es_ES` davefx (converted bundle `vits-piper-es_ES-davefx-medium`) | pinned archive | CC0 (per its model card) | https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models | downloaded (optional) |
| 10 | mlx-audio | 0.4.4 (pinned) | MIT, (c) Prince Canuma | https://github.com/Blaizzy/mlx-audio | downloaded (installed into gentle-speak's own Python env) |
| 11 | Qwen3-TTS-12Hz-0.6B-Base-bf16 (MLX conversion) | `main` | Apache-2.0 (per its Hugging Face card) | https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16 | downloaded (speech: clones a reference WAV) |
| 12 | Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16 (MLX conversion) | `main` | Apache-2.0 (per its Hugging Face card) | https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16 | downloaded only on explicit request (voice design) |
| 13 | espeak-ng (compiled into the sherpa-onnx binaries through piper-phonemize; `espeak-ng-data`) | as bundled by sherpa-onnx 1.13.8 | **GPL-3.0-or-later** | https://github.com/espeak-ng/espeak-ng | downloaded, inside item 5; see the note below |
| 14 | macOS `say` | OS | Apple system software | n/a | external |
| 15 | spd-say (speech-dispatcher) | system | not checked (**unverified**) | https://github.com/brailcom/speechd | external (Linux, optional) |
| 16 | espeak-ng command-line tool | system | GPL-3.0-or-later (upstream; **unverified** for each distribution) | https://github.com/espeak-ng/espeak-ng | external (Linux, optional) |
| 17 | Windows SAPI (System.Speech via PowerShell) | OS | Microsoft system component | n/a | external (Windows) |
| 18 | ffmpeg | system | not checked (**unverified**; LGPL or GPL depending on the build) | https://ffmpeg.org | external (optional, speed change) |
| 19 | uv | system | not checked (**unverified**) | https://github.com/astral-sh/uv | external (optional, creates the Python env) |
| 20 | Python | system | not checked (**unverified**) | https://www.python.org | external (creates and runs the env) |
| 21 | Herdr | system | not checked (**unverified**) | n/a | external (optional, focus probe) |

The `sherpa-onnx` runtime tarballs that gentle-speak installs do not carry their own LICENSE or NOTICE files; consult the upstream repositories above.

## espeak-ng and GPL-3.0

The sherpa-onnx prebuilt binaries include **espeak-ng, which is GPL-3.0-or-later**, through piper-phonemize. This is tracked upstream in [sherpa-onnx issue #3731](https://github.com/k2-fsa/sherpa-onnx/issues/3731) and [issue #4053](https://github.com/k2-fsa/sherpa-onnx/issues/4053); upstream is working to remove it in the 2.x line. It was confirmed locally with `strings` on the 1.13.8 macOS arm64 build: 35 espeak references in `libsherpa-onnx-c-api.dylib`, 7 in `sherpa-onnx.node` and none in `libonnxruntime.dylib`. The espeak-ng license text is its [COPYING file](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING).

**Why gentle-speak stays MIT:** you download the runtime yourself from its upstream npm package; gentle-speak does not bundle, ship or modify it, and runs it in a separate worker process.

**Bundling warning:** anyone who bundles the sherpa-onnx runtime, the Piper bundles' `espeak-ng-data`, or otherwise redistributes them together with gentle-speak takes on GPL-3.0 obligations (source offer, license text, compatible licensing of the combined work) and must review them. This is not legal advice.

## Credits

- **seek-bzip**: the bzip2 decoder used to unpack the Piper bundles.
- **Prince Canuma** and the **mlx-audio** contributors, for the MLX speech library that runs Qwen3-TTS on Apple Silicon.
- The **Qwen team** (Alibaba Cloud), for Qwen3-TTS, and **mlx-community**, for the MLX conversions of the Base and VoiceDesign models.
- The **Piper** project and the authors of the `es_MX` (claude) and `es_ES` (davefx) voices and their datasets, and the **sherpa-onnx** maintainers (k2-fsa) for the converted bundles and the runtime.
- **Pi**, by Mario Zechner and contributors, the coding agent Gentle Shell runs on.
- **Gentle Shell** (gentle-pi), by Alan Buscaglia (Gentleman Programming), the host this extension is built for. Its license file reads Copyright (c) 2025 Mario Zechner, carried over from Pi.
- **gentle-ai**, by Gentleman Programming (MIT, Copyright (c) 2025 Gentleman Programming, https://github.com/Gentleman-Programming/gentle-ai): used only as development tooling; nothing from it is shipped. gentle-speak was built with gentle-ai. gentle-speak is not affiliated with Gentleman Programming.

## Unverified

Not yet verified from source:

- the onnxruntime license file;
- the node-cpal Rust crates' licenses;
- the mlx-audio transitive dependencies' licenses;
- the external tools' licenses (say, spd-say, espeak-ng CLI, SAPI, ffmpeg, uv, Python, Herdr).

Until these are verified, treat them as unknown. Corrections are welcome as issues or pull requests.
