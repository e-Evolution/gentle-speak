---
title: Home
nav_order: 1
translation: es/index.md
description: "gentle-speak reads Gentle Shell's questions and results aloud, with local voices."
permalink: /
---

<img class="home-logo" src="{{ '/assets/images/logo.svg' | relative_url }}" alt="gentle-speak logo: a cursor turning into a sound wave">

# gentle-speak
{: .fs-9 }

Opt-in, local text-to-speech for Gentle Shell (Pi). It reads the agent's questions and usable results aloud, so you do not have to read every answer after each task.
{: .fs-6 .fw-300 }

[Install it](installation.md){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View it on GitHub](https://github.com/e-Evolution/gentle-speak){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What it does

- **Speaks when an agent run settles.** It reads the final questions and usable results. Code blocks, diffs, tool output and turns that call tools are never spoken.
- **Runs on your machine.** Synthesis, voices and the shared Qwen service are local. No audio or voice is uploaded.
- **Starts silent.** Automatic speech is off until you turn it on, and nothing downloads until you confirm it.
- **Uses the voice you choose:**
  - Piper, small and fast;
  - Qwen3-TTS, cloned from your own voice or from a voice you design from a text description (Apple Silicon);
  - your system voice.
- **Works in Gentle Dot too.** It can speak inside Gentle Dot's engine, without changing Dot.

## Who it is for

gentle-speak is for people who use Gentle Shell for long agent runs and would rather listen than keep reading. You can look away while the agent works and still hear when it asks you something or finishes.

## Quick summary

1. Install the package and restart Gentle Shell (for example `gentle-shell -r` to resume your session).
2. Accept the one setup confirmation, «Instalar todo». It downloads the audio runtime and a Piper voice, plus the Qwen parts on Apple Silicon.
3. Run `/speak doctor` to check that everything works.
4. Turn speech on with `ctrl+alt+m`, or `/speak` → **Toggle auto-speak**.

## Read next

| Page | What you find there |
|------|---------------------|
| [Installation](installation.md) | Install from npm, GitHub or a local checkout; the first-start setup; requirements |
| [Usage](usage.md) | Turning speech on, modes, keys, the `speak` tool, copy speech, focus |
| [Voices](voices.md) | The engines, and how to create or import your own voice |
| [Configuration](configuration.md) | Every setting, its default and the settings file |
| [Gentle Dot](gentle-dot.md) | Speaking inside Gentle Dot |
| [Architecture](architecture.md) | How the parts fit together, and how the Qwen models are used |
| [Platforms](platforms.md) | What runs where, and what is verified |
| [Troubleshooting](troubleshooting.md) | `/speak doctor` and common problems |
| [Privacy and security](privacy.md) | What stays local, what is downloaded and from where |
| [Licenses](licenses.md) | The MIT license and third-party components |
| [Contributing](contributing.md) | How to help and how to report a vulnerability |

gentle-speak is a community extension for Gentle Shell. It is not affiliated with Gentleman Programming.
