---
title: Licenses
nav_order: 12
translation: es/licencias.md
---

# Licenses
{: .no_toc }

1. TOC
{:toc}

---

## gentle-speak

gentle-speak is released under the [MIT License](https://github.com/e-Evolution/gentle-speak/blob/main/LICENSE), Copyright (c) 2026 e-Evolution Consultants S.A.

It is a community extension for Gentle Shell (gentle-pi, MIT), by Alan Buscaglia, which runs on Pi, by Mario Zechner. It is **not affiliated with Gentleman Programming**.

## Third-party components

The full list, with every component's version, license, source and relation to the package, is in [THIRD_PARTY_NOTICES.md](https://github.com/e-Evolution/gentle-speak/blob/main/THIRD_PARTY_NOTICES.md). In short:

- **Shipped:** the package contains only gentle-speak's own MIT code, plus `seek-bzip` (MIT) as a normal npm dependency.
- **Peers:** Pi's packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) and Gentle Shell itself, all MIT, are provided by the host.
- **Downloaded by you, never redistributed:** the runtime (sherpa-onnx, onnxruntime, node-cpal), the Piper voices, mlx-audio and the Qwen3-TTS models. You download them from their upstream sources at setup. Their licenses are permissive (Apache-2.0, MIT, ISC, CC0), and the model cards are the authority for the voices and models.
- **External programs:** `say`, `spd-say`, `espeak-ng`, Windows SAPI, `ffmpeg`, `uv`, Python and Herdr run as separate processes already on your system.

| Component | License | Relation |
|-----------|---------|----------|
| seek-bzip 2.0.0 | MIT | shipped |
| sherpa-onnx 1.13.8 | Apache-2.0 | downloaded |
| node-cpal 1.0.0 | ISC | downloaded |
| Piper `es_MX` (claude-high) | Apache-2.0 (dataset, per its model card) | downloaded |
| Piper `es_ES` (davefx) | CC0 (per its model card) | downloaded, optional |
| mlx-audio 0.4.4 | MIT | downloaded |
| Qwen3-TTS Base 0.6B and VoiceDesign 1.7B (MLX conversions) | Apache-2.0 (per their Hugging Face cards) | downloaded |
| espeak-ng, inside the sherpa-onnx binaries | **GPL-3.0-or-later** | downloaded, see below |

## espeak-ng and GPL-3.0

The prebuilt sherpa-onnx binaries include **espeak-ng, which is GPL-3.0-or-later**, through piper-phonemize. Upstream tracks this in [sherpa-onnx issue #3731](https://github.com/k2-fsa/sherpa-onnx/issues/3731) and [issue #4053](https://github.com/k2-fsa/sherpa-onnx/issues/4053).

**Why gentle-speak stays MIT:** you download the runtime yourself from its upstream npm package. gentle-speak does not bundle, ship or modify it, and runs it in a separate worker process.

{: .warning }
If you bundle the sherpa-onnx runtime or the Piper bundles' `espeak-ng-data` yourself, or redistribute them together with gentle-speak, you take on GPL-3.0 obligations. This is not legal advice.

## Not yet verified

Some licenses are still unverified from source:

- the onnxruntime license file;
- the node-cpal Rust crates' licenses;
- the mlx-audio transitive dependencies' licenses;
- the external tools' licenses (`say`, `spd-say`, the `espeak-ng` command, SAPI, `ffmpeg`, `uv`, Python, Herdr).

Treat them as unknown until they are verified. Corrections are welcome as issues or pull requests.

## Credits

- **seek-bzip**, the bzip2 decoder used to unpack the Piper bundles.
- **Prince Canuma** and the **mlx-audio** contributors, for the MLX speech library that runs Qwen3-TTS on Apple Silicon.
- The **Qwen team** (Alibaba Cloud), for Qwen3-TTS, and **mlx-community**, for the MLX conversions of the Base and VoiceDesign models.
- The **Piper** project, the authors of the `es_MX` (claude) and `es_ES` (davefx) voices and their datasets, and the **sherpa-onnx** maintainers (k2-fsa), for the converted bundles and the runtime.
- **Pi**, by Mario Zechner and contributors, the coding agent Gentle Shell runs on.
- **Gentle Shell** (gentle-pi), by Alan Buscaglia (Gentleman Programming), the host this extension is built for.
- **gentle-ai**, by Gentleman Programming (MIT), used only as development tooling. Nothing from it is shipped. gentle-speak was built with gentle-ai.
