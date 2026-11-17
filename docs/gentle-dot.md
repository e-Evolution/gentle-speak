---
title: Gentle Dot
nav_order: 6
translation: es/gentle-dot.md
---

# Gentle Dot
{: .no_toc }

gentle-speak can speak inside Gentle Dot's engine, without changing Dot.

1. TOC
{:toc}

---

## The offer

On the first terminal start, if Gentle Dot is installed and its `settings.json` does not list gentle-speak, you are asked once:

> «Encontré Gentle Dot. ¿Querés que también hable ahí?»

- **Yes** connects it (see below).
- **No** is remembered (`dotOffer: "declined"` in the terminal's settings), and you are not asked again.

gentle-speak looks for Dot's engine home in `GENTLE_DOT_AGENT_HOME`, by default `~/.gentle-dot/agent`.

## Connect and disconnect

Open `/speak` → **Gentle Dot**. The first line shows the state, for example `Gentle Dot: conectado · habla: sí · voz es_MX · modo questions-and-results`. The items are:

| Item | What it does |
|------|--------------|
| **Conectar Gentle Dot** | Backs up Dot's `settings.json`, adds the gentle-speak package to it, and turns on speech in Dot's own speak settings |
| **Desconectar Gentle Dot** | Backs up Dot's `settings.json`, removes only gentle-speak's entry, and sets Dot's `enabled` to `false`. Dot's speak settings file is kept |
| **Hablar en Dot** | Turns speech in Dot on or off |
| **Voz de Dot** | Chooses Dot's voice, from the same list as the terminal |
| **Modo de Dot** | Chooses Dot's mode: `all`, `questions-and-results` or `summary` |
| **Volver** | Goes back |

Details:

- The backup is `settings.json.gentle-speak-backup-<timestamp>`, next to the original. An earlier backup is never overwritten.
- On the first connection, Dot's speak settings are seeded from the terminal's, with `enabled: true` and `copySpeech: false`.
- A malformed Dot `settings.json` is never written; you get a warning instead.
- **Restart Dot** after connecting or disconnecting.

## Mute Dot's own voice

Dot has its own spoken replies. Turn them off with Dot's **«Mute spoken replies»** button, the speaker icon in the chat header. Otherwise you hear every answer twice. After connecting, gentle-speak reminds you: «Gentle Dot conectado: silenciá la voz propia de Dot y reinicialo.»

## Its own settings

Dot has its own settings file: `<Dot HOME>/.gentle-speak/speak-settings.json`.

- Dot's HOME is `dirname(<Dot agent home>)/home`, so by default `~/.gentle-dot/home`. `GENTLE_DOT_HOME` overrides it.
- Dot speaks only if its own `enabled` is `true`. The terminal's settings do not turn Dot on or off.
- The file has the same keys as the terminal's; see [Configuration](configuration.md#settings).

Shared with the terminal, so nothing downloads twice:

- the native runtime and the Piper models;
- your own voices;
- the Hugging Face cache;
- the shared Qwen service;
- the voice lock, so Dot never talks over the terminal.

## What speaks in Dot

Only Dot's root RPC session speaks. It uses the same voice, mode, filter, speculation and voice lock as the terminal, with two differences:

- It takes its turn at once: there is no focus deferral.
- Every text starts with the prefix `Dot: `, so you can tell which app is talking.

Dot has no SPEAK row, no shortcuts and no copy speech.

## Accepted package sources

gentle-speak writes or recognizes only these entries in Dot's `settings.json`, and nothing else:

- an absolute local directory whose `package.json` name is `@e-evolution/gentle-speak` (or the legacy `gentle-speak`);
- `npm:@e-evolution/gentle-speak`, optionally with `@<version>` (or the legacy `npm:gentle-speak`);
- a git source of a repository named `gentle-speak`: `git:<host>/<owner>/gentle-speak[.git][@ref]` or `https://<host>/<owner>/gentle-speak[.git][@ref]`.

Credentials, queries, fragments, ssh and file forms, and other names are refused, and nothing is written.

## Check the connection

`/speak doctor` reports the Dot connection: ✓ connected, – not installed or not connected, or ✗ when Dot's `settings.json` is malformed. See [Troubleshooting](troubleshooting.md).
