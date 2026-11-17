---
title: Usage
nav_order: 3
translation: es/uso.md
---

# Usage
{: .no_toc }

1. TOC
{:toc}

---

## Turn speech on

Automatic speech is **off** until you turn it on. Use either:

- the toggle key, `ctrl+alt+m` by default; or
- `/speak` → **Toggle auto-speak**.

The same toggle turns it off again. Turning it off also drops speech that was waiting for your pane to get focus.

## What gets spoken

When an agent run settles, gentle-speak decides whether to speak the final assistant prose.

It never speaks:

- code blocks, diffs or tool output;
- turns that call tools.

RPC, print, JSON and delegated child sessions never speak. The one exception is Gentle Dot's own root session; see [Gentle Dot](gentle-dot.md). Reloading or shutting down stops audio and drops pending speech.

## Modes

Choose a mode with `/speak` → **Mode: all**, **Mode: questions-and-results** or **Mode: summary**.

| Mode | What is spoken |
|------|----------------|
| `questions-and-results` (default) | Final questions and usable results. Plain "I'm checking…" narration is skipped |
| `all` | Every final prose answer |
| `summary` | One short Spanish sentence written by a model you choose (`/speak` → **Summary model**). With no model selected, nothing is spoken |

In `summary` mode, the sanitized final prose (never tool output) is sent to the model you pick. That model may be a cloud provider, with its usual costs. **Summary model** lists only models that have credentials configured, plus **None**.

## Keyboard shortcuts

| Default key | Action | What it does |
|-------------|--------|--------------|
| `ctrl+alt+v` | `speakLast` | Speak the last assistant message |
| `ctrl+alt+.` | `stop` | Stop playback |
| `ctrl+alt+m` | `toggle` | Turn automatic speech on or off |
| `ctrl+alt+n` | `cycleVoice` | Switch to the next available voice |
| `ctrl+alt+c` | `toggleCopy` | Turn copy speech on or off |

The stop key stops only your own session's speech, not another terminal's.

### Rebind a key

1. Open `/speak` → **Key: speakLast**, **Key: stop**, **Key: toggle**, **Key: cycleVoice** or **Key: toggleCopy**.
2. Type the new key, for example `ctrl+alt+j`.
3. Restart Gentle Shell to apply it, for example `gentle-shell -r` to resume your session. The confirmation says «Restart Gentle Shell (for example gentle-shell -r) to apply shortcut changes». Do not use `/reload`: it can crash Gentle Shell 4.7.0.

A key is one or more of `ctrl+`, `alt+` and `shift+`, followed by a single letter, a digit, or one of `.` `,` `;` `/`. Duplicates are refused, and so are keys that Pi and Gentle Shell reserve (`ctrl+k`, `ctrl+p`, `alt+k`, `alt+a`). An invalid key is not saved: you see «Invalid speech settings; nothing was saved.»

## The `speak` tool

The model can also speak on purpose through the **`speak`** tool, even when automatic speech is off. It takes one `text` argument:

- up to 4000 characters;
- not empty, and with no control characters (so no line breaks).

It speaks only in an interactive parent session (or Gentle Dot's root session). When your pane does not have focus, the tool answers «Speech deferred until this pane has focus.» and the text is spoken later; see [Focus](#focus-with-several-panes).

## Speak copied text

Copy speech reads aloud text you select and copy in **this** Gentle Shell.

- It is **off** by default. Turn it on with `/speak` → **Toggle speak copied selection**, or `ctrl+alt+c`.
- It works on **macOS only**, in the fullscreen TUI.
- It is gated on your own copy. The terminal app must be frontmost, and the copied text must be the visible selection.
- Concealed, transient and password-manager copies are skipped.
- Clipboard text is never stored or logged.

## The SPEAK row

In the interactive terminal, a `SPEAK` row appears under INTEGRATIONS, for example:

```text
SPEAK ● on · modo todo · Propia · Ana · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c
```

It shows, in order:

- the state (`● on` or `○ off`);
- the mode (`modo todo`, `modo preguntas y resultados` or `modo resumen`; `modo resumen sin modelo` when no summary model is set);
- the voice;
- your toggle and cycle-voice keys;
- the copy speech state and its key.

It is a status row, not a clickable control. Gentle Shell has no public click API for it.

## Focus with several panes

Automatic speech and the `speak` tool play at once when your pane has focus. Otherwise, only the **latest** result of that session is kept, and it is spoken when you focus the pane. The kept result is dropped when you turn speech off, press stop, reload or shut down.

gentle-speak learns about focus from these sources, in order:

1. the terminal's own focus reports (pi-tui's `ESC[I` / `ESC[O`; inside tmux, set `focus-events on`);
2. Herdr (`HERDR_ENV=1`, then `herdr pane get $HERDR_PANE_ID`);
3. on macOS, the frontmost app, which must be your terminal;
4. typing: when the terminal sends no focus events at all, input in the last 60 seconds counts as focus.

When focus is unknown, the turn is spoken in order and starts with the project name, for example `my-project: …`.

`HERDR_BIN_PATH` is honored only as an absolute path to an executable named `herdr`.

{: .note }
Shift+F3, Alt+Shift+F3 and Ctrl+F3 send `ESC[1;<modifier>R`, which is byte for byte the terminal's cursor-position reply for row 1. Those three keys alone therefore do not count as typing. Every other modified key does, and the other focus sources are unaffected.

## One voice at a time

Every playback holds a cross-process lock in `~/.gentle-speak/`. Sessions in different terminals, Herdr panes and Gentle Dot take turns and never talk over each other. If the process holding the lock died, the lock is reclaimed.
