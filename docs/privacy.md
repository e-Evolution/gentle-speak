---
title: Privacy and security
nav_order: 11
translation: es/privacidad.md
---

# Privacy and security
{: .no_toc }

1. TOC
{:toc}

---

## Everything runs locally

Synthesis, voices and the shared Qwen service run on your machine. No audio and no voice is uploaded.

The one exception is a mode you choose: `summary` mode sends the sanitized final prose (never tool output) to the model **you** pick, which may be a cloud provider with its usual costs. With no model chosen, nothing is sent.

## No network before you confirm

- Nothing downloads, loads or starts when Pi starts.
- No network request happens before the setup confirmation. The sizes it shows are pinned approximate values, not looked up online.
- The same holds for the VoiceDesign download: its size is pinned, and nothing reaches Hugging Face before you confirm.

## What is downloaded, and from where

Only after your confirmation:

| What | From |
|------|------|
| Native audio runtime (sherpa-onnx, node-cpal) | The npm registry, as pinned tarballs with pinned hashes |
| Piper voice bundles | The sherpa-onnx GitHub releases, as pinned archives with pinned sha256 hashes |
| Python packages for Qwen (Apple Silicon) | PyPI, as a hash-locked set |
| A CPython build, only when Python 3.12 is missing | `uv`, into its own directory `~/.local/share/uv/python` |
| Qwen3-TTS Base and VoiceDesign models | Hugging Face, into its cache |

A download whose hash does not match is refused.

### Hash-locked Python dependencies

The Qwen environment installs `mlx-audio==0.4.4` and every one of its dependencies from a lock file, `scripts/requirements-qwen.txt`. Each package is pinned to one version with its sha256 hashes and installed with `--require-hashes`. A package whose hash does not match is refused.

### The installers cannot be steered by your project

- The installers run from `~/.gentle-speak`, never from your current project.
- `uv` runs with `--no-config`.
- A `uv.toml`, `pip/` or `venv/` in the directory where you started Gentle Shell cannot change what is installed.

### What else setup writes

Besides `~/.gentle-speak`, setup writes the pip or uv download caches and the Hugging Face cache (`HF_HOME`, default `~/.cache/huggingface`).

## Voices and consent

- **Imported recordings** need an explicit confirmation that the voice is yours or that you have the person's permission: «Es mi voz o tengo consentimiento explícito de la persona».
- **Designed voices** use only your text, never anyone's audio.
- Your voices are stored in `~/.gentle-speak/voices/custom/` and never uploaded.

## What is never spoken

- Code blocks, diffs and tool output.
- Turns that call tools.
- RPC, print, JSON and delegated child sessions (Gentle Dot's root session is the one exception, and only when you connect it).
- Copy speech skips concealed, transient and password-manager clipboard content, and only speaks text you copied from this Gentle Shell. Clipboard text is never stored or logged.

## Local files

- The settings file is written atomically with mode 0600.
- The shared Qwen service listens on a private Unix socket, `~/.gentle-speak/qwen.sock` (mode 0600, in a 0700 directory).

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. You should get a first answer within 7 days.

In scope:

- the downloads and their pinned hashes, and archive extraction;
- the Python environment setup;
- the local Qwen service socket under `~/.gentle-speak`;
- importing a user's voice recording;
- anything that could make gentle-speak read aloud, copy or send data you did not choose.

Vulnerabilities in the upstream projects (sherpa-onnx, mlx-audio, Piper voices, Qwen3-TTS models, Gentle Shell) belong to those projects.

The full policy is [SECURITY.md](https://github.com/e-Evolution/gentle-speak/blob/main/SECURITY.md).
