---
title: Voices
nav_order: 4
translation: es/voces.md
---

# Voices
{: .no_toc }

1. TOC
{:toc}

---

## The engines

| Engine | Needs | Offers |
|--------|-------|--------|
| **Piper** via sherpa-onnx | The native runtime (about 18 MB) and a voice bundle (`es_MX` about 67 MB; `es_ES` optional) | Local and fast, no cloning. Fixed voices `es_MX` (the default) and `es_ES` |
| **Qwen3-TTS** via mlx-audio | macOS on Apple Silicon, gentle-speak's own Python environment, the Base 0.6B model (and VoiceDesign 1.7B to design a voice) | Clones a reference WAV for every utterance: your own voices or voices you designed |
| **System voice** (`say`, `spd-say`, `espeak-ng`, SAPI) | Nothing to download | An extra voice, and the automatic fallback |

**Other engines and models are not supported yet.** You can still use a voice made with another tool; see [Import a voice made elsewhere](#import-a-voice-made-with-another-tool).

### Piper

The Piper voices are Spanish: `es_MX` (Español (México), installed by setup) and `es_ES` (Español (España), optional). They synthesize in the audio worker with sherpa-onnx, with no Python.

### Qwen3-TTS

No Qwen voice is bundled. Qwen voices are always your own: designed from a description or cloned from a recording. Speaking always uses the Base 0.6B model with your voice's reference audio and its exact transcript. See [How the Qwen models are used](architecture.md#how-the-qwen-models-are-used).

### System voice

- macOS uses `say`.
- Linux uses `spd-say` when present, else `espeak-ng` or `espeak`.
- Windows uses SAPI through `powershell.exe`, which must be on `PATH`.

The text always travels on standard input, never on the command line.

`/speak` → **Voz del sistema** lists the platform's Spanish voices, plus `Auto`. `Auto` picks Paulina, then Mónica on macOS; Sabina, then Helena on Windows; and a Latin-American Spanish voice, then `es`, on Linux. In menus the voice is labelled `Mac` on macOS and `Sistema` elsewhere; its id is always `mac`.

The system voice is also the **fallback**. When the selected Piper or Qwen voice is not installed or fails, gentle-speak speaks with the system voice and tells you once per session. A stop or a cancel never falls back. Turn this off with `/speak` → **Toggle Mac fallback**.

## Choose a voice

- `/speak` lists every voice as `Voice: <label> (<id>) — installed` or `— not installed`. Pick one there.
- Press `cycleVoice` (`ctrl+alt+n`) to switch to the next available voice.
- For Gentle Dot, use `/speak` → **Gentle Dot** → **Voz de Dot**.

Picking a Piper voice that is not installed yet keeps the choice and tells you to run `/speak` → **Install voice and runtime**.

## Your own voice

Qwen voices need macOS on Apple Silicon and the Qwen parts of the setup (`/speak` → **Instalar todo**). Three `/speak` items manage them:

| Item | What it does |
|------|--------------|
| **Crear voz propia…** | Designs a voice from a text description, with VoiceDesign |
| **Importar mi grabación…** | Clones a recording of your voice, after an explicit consent confirmation |
| **Borrar voz propia…** | Deletes one of your voices, after a confirmation |

Your voices appear as `Propia · <label>` in the `/speak` voice list, in `cycleVoice` and in Dot's voice picker. They are selected as `custom:<id>`.

### Design a voice from a description

`/speak` → **Crear voz propia…**

1. The first time, it asks to download the VoiceDesign model (`mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16`, about 4.5 GB) from Hugging Face into your cache. Nothing downloads unless you confirm. This model is used only to design; speaking keeps using the Base model.
2. Describe the voice in 10 to 600 characters, for example «femenina, adulta, cálida, acento mexicano».
3. Give it a name of up to 40 characters.
4. Give a sample sentence of 40 to 400 characters, or leave it empty to use the suggested one. The sample is spoken once to create the reference audio, which must come out between 3 and 30 seconds long.

Designing loads the model and can take about a minute; you are told when it finishes. A designed voice uses only your text, never audio of anyone.

### Clone your own recording

`/speak` → **Importar mi grabación…**

1. Confirm consent: «Es mi voz o tengo consentimiento explícito de la persona». Without it, nothing is imported.
2. Give the path of a WAV file. It must be an absolute path or start with `~/`.
3. Type the **exact transcript** of what is said in the recording (1 to 500 characters).
4. Give the voice a name of up to 40 characters.

The recording must be:

- a PCM WAV (8, 16, 24 or 32 bits, 8 to 192 kHz);
- between **3 and 30 seconds** long;
- at most 32 MiB.

A 16-bit mono WAV is copied as it is. Any other WAV is converted to 16-bit mono with `ffmpeg`, which must then be installed. The stored reference is at most 16 MiB.

{: .warning }
Never clone a real person's voice without their consent.

### Import a voice made with another tool

gentle-speak does not run other TTS engines, but Qwen can clone any reference audio. Export a sample from the other tool as a WAV (3 to 30 seconds, with its exact transcript) and import it with «Importar mi grabación…». The same consent rule applies.

### Where your voices live

Each voice is stored in `~/.gentle-speak/voices/custom/<id>/`:

- `reference.wav`, the reference audio;
- `voice.json`, with the id, label, transcript, description, language, source (`designed` or `recorded`), creation time and **sha256** of the audio.

The sha256 is checked every time the voice is used. A missing or invalid voice is skipped with a notice, and a selected voice that is missing falls back like any missing voice.

Your voices stay on your machine and are never uploaded.

### Delete a voice

`/speak` → **Borrar voz propia…**, pick the voice and confirm. This cannot be undone. If the deleted voice was selected, the voice goes back to the default, `es_MX`.

## Voices from earlier releases

Earlier releases shipped seven built-in `qwen-*` reference voices. At the next session start, an existing `voices/qwen3/` install with a valid manifest is converted once into your own voices, with the same label, transcript and sha256. The WAVs are copied and nothing is deleted. Settings that say `qwen-<name>` are mapped to `custom:<name>`, for the terminal and for Dot.
