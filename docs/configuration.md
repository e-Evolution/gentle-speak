---
title: Configuration
nav_order: 5
translation: es/configuracion.md
---

# Configuration
{: .no_toc }

1. TOC
{:toc}

---

## Use `/speak`

`/speak` is the way to change settings. It validates every change and writes the file for you. Run `/speak` in the interactive terminal and pick an item:

- **Gentle Dot**: the Gentle Dot submenu (see [Gentle Dot](gentle-dot.md))
- **Toggle auto-speak**
- **Mode: all**, **Mode: questions-and-results**, **Mode: summary**
- **Summary model**
- **Voice: …**: every voice, with its state (`installed` or `not installed`)
- **Crear voz propia…**, **Importar mi grabación…**, **Borrar voz propia…** (see [Voices](voices.md))
- **Voz del sistema**
- **Toggle Mac fallback**
- **Mantener Qwen tras cerrar la última sesión**
- **Detener servicio Qwen** (shown only while the shared Qwen service is running)
- **Speed**
- **Key: speakLast**, **Key: stop**, **Key: toggle**, **Key: cycleVoice**, **Key: toggleCopy**
- **Install voice and runtime**: the selected Piper voice and the native runtime, each confirmed separately
- **Instalar todo**: the full setup (see [Installation](installation.md#first-start-setup))
- **Doctor**: the same as `/speak doctor`
- **Toggle speak copied selection**
- **Stop playback**
- **Cancel**

After a change you see «Speech settings saved.» Shortcut changes need a restart; see [Rebind a key](usage.md#rebind-a-key).

## The settings file

Settings are stored in `speak-settings.json`:

- schema `gentle-speak.settings/v1`;
- written atomically, with file mode 0600;
- a missing or malformed file means the defaults, so speech is **off**.

**Each app has its own file.** Each app reads `$HOME/.gentle-speak/speak-settings.json`:

- the terminal's is `~/.gentle-speak/speak-settings.json`;
- Gentle Dot's is `<Dot HOME>/.gentle-speak/speak-settings.json` (see [Gentle Dot](gentle-dot.md#its-own-settings)).

Downloaded parts, your voices and the voice lock are always shared from the real `~/.gentle-speak`, so nothing downloads twice.

{: .note }
Prefer `/speak` to editing the file by hand. A file with an unknown key, a wrong type or an invalid value is ignored as a whole, and the defaults apply.

## Settings

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `enabled` | boolean | `false` | Automatic speech on or off |
| `mode` | string | `questions-and-results` | `all`, `questions-and-results` or `summary` (see [Modes](usage.md#modes)) |
| `voice` | string | `es_MX` | `es_MX`, `es_ES`, `mac` (the system voice) or `custom:<id>` |
| `speed` | number | `1` | Speech speed, from 0.5 to 2 |
| `summaryModel` | object or `null` | `null` | `{provider, id}` of the model for `summary` mode |
| `copySpeech` | boolean | `false` | Speak copied selections (macOS) |
| `macVoice` | string or `null` | `null` | System voice name; `null` picks the best installed Spanish voice |
| `macFallback` | boolean | `true` | Speak with the system voice when the chosen voice is missing or fails |
| `qwenIdleMinutes` | integer or `null` | `10` | Minutes the shared Qwen service stays loaded after the last session closes (1 to 60); `null` means never unload |
| `shortcuts` | object | see below | Keys for `speakLast`, `stop`, `toggle`, `cycleVoice` and `toggleCopy` |
| `dotOffer` | `"declined"` or `null` | `null` | Remembers that you declined the Gentle Dot offer |
| `setupOffer` | `"declined"` or `null` | `null` | Remembers that you declined the first-start setup |
| `dotSpeech` | boolean | `false` | Legacy Dot flag; ignored now (Dot uses its own settings file) |

Default `shortcuts`:

```json
{
  "speakLast": "ctrl+alt+v",
  "stop": "ctrl+alt+.",
  "toggle": "ctrl+alt+m",
  "cycleVoice": "ctrl+alt+n",
  "toggleCopy": "ctrl+alt+c"
}
```

### Speed

`/speak` → **Speed** takes a number from 0.5 to 2. On Qwen voices, a speed other than 1 needs `ffmpeg`. Without it, Qwen voices play at their native speed and tell you so once.

### Qwen idle time

`/speak` → **Mantener Qwen tras cerrar la última sesión** offers `1 min`, `2 min`, `5 min`, `10 min`, `30 min`, `60 min` and `Nunca`. The change applies at once, without a restart. `/speak` → **Detener servicio Qwen** stops the service now; the next Qwen speech starts it again. See [The shared Qwen service](architecture.md#the-shared-qwen-service).

### System voice

`/speak` → **Voz del sistema** sets `macVoice`: `Auto` (stored as `null`) or one of the installed Spanish voices. See [System voice](voices.md#system-voice).

## Example

A complete file, as `/speak` writes it (on one line):

```json
{"schema":"gentle-speak.settings/v1","enabled":true,"mode":"questions-and-results","voice":"es_MX","speed":1,"summaryModel":null,"copySpeech":false,"macVoice":null,"macFallback":true,"dotSpeech":false,"dotOffer":null,"setupOffer":null,"qwenIdleMinutes":10,"shortcuts":{"speakLast":"ctrl+alt+v","stop":"ctrl+alt+.","toggle":"ctrl+alt+m","cycleVoice":"ctrl+alt+n","toggleCopy":"ctrl+alt+c"}}
```
