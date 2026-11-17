---
title: Hardware, tokens and speed
nav_order: 9
translation: es/requisitos.md
---

# Hardware, tokens and speed
{: .no_toc }

What each voice needs, what the extension adds to your token use, and how fast it speaks. Numbers are marked **measured** (taken on a real machine) or **estimate** (derived from the code or from a rule of thumb).

1. TOC
{:toc}

---

## Hardware

Disk sizes are in [What setup installs](installation.md#what-setup-installs); they are not repeated here.

| Voice | Runs on | Memory | Download (see the table) |
|-------|---------|--------|--------------------------|
| **Piper** (`es_MX`, `es_ES`) | CPU, through sherpa-onnx. macOS, Linux and Windows (only macOS on Apple Silicon has been run live; see [Platforms](platforms.md)) | **Measured:** the synthesis process peaked at about 0.3 GB for one sentence and about 0.55 GB for a 600-character text | Runtime about 18 MB, voice about 67 MB |
| **Qwen3-TTS Base 0.6B** (your own voices) | **Apple Silicon only**, with MLX. Needs Python 3.12 or newer (or `uv`) | About 2.6 GB, loaded **once** and shared by all your sessions, not once per session (as documented in [Architecture](architecture.md#the-shared-qwen-service)) | Model about 2.5 GB, Python environment about 480 MB |
| **VoiceDesign 1.7B** (only to design a voice) | Apple Silicon only | **Not measured.** It is a larger model than Base, so expect it to need more memory than 2.6 GB while you design a voice | About 4.5 GB, only if you confirm it |
| **System voice** | `say` on macOS; Linux and Windows tools are untested live | Provided by the operating system; **not measured** | Nothing |

All voices need **Node.js 24 or newer**.

**Minimum and recommended (from the facts above):**

- **Piper only:** any machine that runs Gentle Shell on a supported platform. About 85 MB of disk and well under 1 GB of memory for synthesis.
- **Qwen voices:** an Apple Silicon Mac with about 2.6 GB of memory free for the shared model, about 3 GB of disk for the model and its environment, and Python 3.12 or newer. We have not measured which Apple Silicon chips or memory sizes are comfortable; no minimum chip is stated because none was tested.
- **Designing a voice:** add about 4.5 GB of disk. Free memory for it was not measured.

## Tokens

These are **estimates**. The method: a token is about 4 characters in English and about 3 to 4 in Spanish, so characters divided by 3 to 4 gives the token count. Your model's tokenizer may differ.

| Feature | Extra model calls | Tokens it adds |
|---------|-------------------|----------------|
| Auto-speech in `all` and `questions-and-results` | **0** | **0.** It reuses the final text the agent already wrote. |
| Shortcuts, `/speak` menu and copy speech | **0** | **0** |
| The `speak` tool **definition** | 0 | A fixed **253 characters**, about **65 input tokens** at 4 characters per token, on **every** model request of a session that has the extension. The provider's own wrapping can add a little. |
| A `speak` **call** | 0 extra (it is a tool call in the turn) | The text you ask it to say as **output tokens**: up to 4000 characters, so about 1000 to 1300 tokens at most. The tool answers with a short text such as «Speech completed.» (a handful of tokens). |
| **Summary mode** | **1 per spoken result** | See below. |

Why auto-speech costs nothing: the extension only reads the finished conversation after the run settles, filters it and speaks it. It never sends a message, adds an entry or injects text into the model's context.

### Summary mode, per result

Each spoken result makes one extra call to the summary model you chose:

- **Input:** a one-line instruction (about 40 tokens) plus **at most 2000 characters** of the result, about 500 to 670 tokens. So roughly **40 to 700 input tokens**, depending on how long the result is.
- **Output:** **at most 80 tokens** (`maxTokens: 80`); one short sentence is usually much less.
- **Caching:** the call sets `cacheRetention` to `none`, so it does not keep a prompt cache.

A model that runs locally costs no tokens from a paid plan. If the call fails, nothing is spoken and nothing falls back to the unsummarized text.

### Which sessions pay the tool definition

The `speak` tool is registered whenever the extension loads, in **every** session that loads it, including child and RPC sessions, so each of them pays the definition tokens. It only **works** in the interactive terminal parent session and in Gentle Dot's engine session; elsewhere a call returns «Speech requires an interactive parent TUI session.» If you do not want the definition cost, do not load the extension in those sessions.

## Speed

| What | Value |
|------|-------|
| Piper, one sentence (57 characters, about 4 s of audio) | **Measured:** about 0.21 s to synthesize, a real-time factor of about 0.05 (about 20 times faster than playback) |
| Piper, 613 characters (about 37 s of audio) | **Measured:** about 2.2 s to synthesize, a real-time factor of about 0.06 |
| Piper, loading the voice | **Measured:** about 0.24 s |
| Qwen, streamed parts | Audio is sent as each part of about 2 seconds is ready, so you do not wait for the whole text |
| Qwen, first sound | About 1.5 s on a warm model (documented in [Architecture](architecture.md#streamed-parts)); **not measured here** |
| Qwen, speculative synthesis | While the answer is still being written, completed sentences are synthesized ahead, so the first sound can start earlier (not in `summary` mode) |
| Qwen, cold start | The first load of the shared service is slower than a warm one; **not measured** |
| Qwen, staying loaded | The shared service stays loaded 10 minutes by default after the last session closes (`qwenIdleMinutes`); the next utterance after it unloads pays a cold start |

**How the Piper numbers were measured:** on an Apple Silicon Mac, in November 2026, with the installed `es_MX` voice, the CPU, two threads and speed 1.0. Each text ran 3 times in a fresh process and the table shows the median. Synthesis only: nothing was played. The time is for the second synthesis call in a process (the first call of each process was within about 10 % of it). Your machine will differ. The Qwen numbers are not measured because doing so would have meant starting a separate model service; only the documented values are given.

Changing the speed of Qwen voices needs the optional `ffmpeg` (see [Installation](installation.md#requirements)).
