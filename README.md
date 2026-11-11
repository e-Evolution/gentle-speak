# gentle-speak

Opt-in local text-to-speech for Pi / Gentle Shell. This README is the package instruction page, not a claim that the extension is published or independently audited. [Preview](assets/preview.png) is a speech illustration, **not** a UI screenshot.

## Install and use

Requires Node.js 24+, Gentle Shell (Pi), and an interactive parent TUI session. **Automatic speech is off by default.** Loading the extension does not install voice models or start native audio.

### Try in your current Gentle Shell (available now)

From this checkout, with its dependencies installed:

```bash
cd ~/Develop/AI/gentle-speak
npm ci
gentle-shell -- -e ./extensions/gentle-speak.ts
```

This loads gentle-speak **only for that Gentle Shell launch**, alongside Gentle Shell's own package; it does not change the configured package list. It uses your current isolated Gentle Shell home (`~/.gentle-shell/agent`). Voice/runtime installation still requires separate confirmations inside `/speak` and stores them under `~/.gentle-speak/`. This temporary route is appropriate for the pending live TUI test; it is not a publication or audit verdict.

After verification, to keep the local checkout installed in the same Gentle Shell home:

```bash
cd ~/Develop/AI/gentle-speak
npm ci
gentle-shell install ./
gentle-shell
```

Run `/reload` if Gentle Shell was already open. `gentle-shell remove ./` from this directory removes the package declaration later. Local packages load in place, so keep the checkout and its `seek-bzip` dependency available. **Persistent installation is not recommended until the installer audit and live TUI check pass.** There is no published npm package or Gentle Hub listing yet.

### From GitHub (only after this repository is public and verified)

```bash
gentle-shell install git:github.com/e-Evolution/gentle-speak
gentle-shell
```

This Git command is **not available yet** and follows the repository's current default branch; pin a release tag (`@<tag>`) once one actually exists. Git-backed packages install their declared dependencies automatically. Do not use `npm install gentle-speak` until an npm release exists.

### First playback

1. In Gentle Shell's interactive parent TUI, run `/speak` → **Install voice and runtime**. Confirm the converted voice bundle (about 67 MB) and native runtime download **separately**; declining either performs no download for that artifact.
2. Choose `es_MX` (default) or `es_ES` under `/speak`. They are separate converted Piper TTS bundles, not the Parakeet dictation model. Invalid artifacts are never silently replaced.
3. Use `/speak` → **Toggle auto-speak**. The default `questions-and-results` mode reads eligible final questions and usable results; `all` reads other final prose. Code blocks, diffs, and tool output are excluded. `/speak` also changes speed (0.5–2).

Manual speech uses the `speak` tool or the speak-last shortcut after installation, even when automatic speech is off.

For `summary` mode choose `/speak` → **Summary model** and select an available authenticated Pi model. The selected provider may use the network and incur its normal costs; only sanitized final assistant prose is sent, not tool output. With no selected model, summary speech is unavailable.

Default shortcuts: `ctrl+alt+v` speaks the last assistant message, `ctrl+alt+.` stops playback, `ctrl+alt+m` toggles automatic speech, `ctrl+alt+n` switches to the next installed voice (catalog order, wrapping), and `ctrl+alt+c` toggles speaking copied selections (same as `/speak` → **Toggle speak copied selection**, with the same privacy notice). Rebind under `/speak` → **Key: speakLast**, **Key: stop**, **Key: toggle**, **Key: cycleVoice**, or **Key: toggleCopy**; run `/reload` to register new keys. Pi and Gentle Shell reserved keys and duplicate bindings are rejected. `/reload` and session shutdown stop playback and drop queued speech. Settings live at `~/.gentle-speak/speak-settings.json`; missing or malformed settings mean off. RPC, print, JSON, and delegated child sessions never speak.

In the interactive parent TUI, a **SPEAK** row appears under Gentle Shell's INTEGRATIONS rail section in both states, e.g. `SPEAK ● on · modo todo · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c` (or `○ off`; `copia ●` while speaking copied selections is on). It always shows the copy state with its key, shows your configured keys and updates after a toggle, a voice change, or a key rebind; it is cleared on shutdown or `/reload` and never shown in RPC, print, JSON, or child sessions. It is a status row, not a clickable control: Gentle Shell exposes no public rail or mouse API.

Qwen3-TTS voices (`qwen-suave`, `qwen-brisa`, `qwen-coqueta`, `qwen-maestra`, `qwen-intima`, `qwen-serena`, `qwen-viva`) clone a local reference WAV through mlx-audio. Their WAVs are not in this repository: a sha256-verified installer copies them to `~/.gentle-speak/voices/qwen3/` and refuses to overwrite a different file. Piper `es_MX` stays the default.

#### Qwen voices

Requires macOS on Apple Silicon and a Python with `mlx-audio` (and its dependencies, e.g. `packaging`) importable **under `python -I`** (isolated mode ignores user site-packages), plus the cached model `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16` (the worker runs with `HF_HUB_OFFLINE=1` and never downloads). If a Qwen voice is selected but not installed, speech is refused with an error naming this section and nothing is started. When installed, the first utterance starts `scripts/speak-qwen-worker.py` lazily (the model loads once, a few seconds), long text is synthesized in sentence groups so playback starts early, and the stop key, `/reload` and shutdown kill the worker. Speeds other than 1 need `ffmpeg` on `PATH` (pitch-preserving); without it Qwen voices play at native speed and say so once. Audio still uses the node-cpal runtime installed by `/speak`. Choose a voice under `/speak`: the menu lists every catalog voice (label, id, installed or not); picking an uninstalled voice explains how to install it and changes nothing.

Your own voice: `/speak` → «Crear voz propia…» (designed from text) or «Importar mi grabación…» (your own recording, with consent); they appear as `Propia · <label>`.

#### Memory (Qwen voices)

Every Gentle Shell session and Gentle Dot share **one** local Qwen service, so the model (about 2.6 GB) is loaded once, not once per session. The first session that needs it starts it, detached, and later sessions connect to it. It owns the only Python worker and listens on a private unix socket, `~/.gentle-speak/qwen.sock` (mode 0600 in a 0700 directory owned by you; it accepts only its own protocol and validates every request). It runs one synthesis at a time: the session that holds the voice lock goes before speculative synthesis, and a queued speculation can be cancelled.

- **While sessions are open.** The model stays loaded as long as at least one session (terminal or Dot) is connected, even if nobody speaks. A session that uses the service keeps one lightweight connection from its first speech until it closes or you `/reload`; if the connection drops it reconnects at the next speech (starting the service once if needed), so «Detener servicio Qwen» stays stopped until the next speech needs it.
- **After the last session.** When the last session disconnects, a grace countdown of `qwenIdleMinutes` starts from that moment (default 10; `/speak` → `Mantener Qwen tras cerrar la última sesión`: 1, 2, 5, 10, 30, 60 min or `Nunca`). When it ends the service unloads Python and exits, removing its socket and pid; a session that connects during the grace cancels it. `Nunca` keeps the service until `Detener servicio Qwen` or a restart of the Mac. The value is read when the service starts: a change applies the next time it starts (use `Detener servicio Qwen` to apply it now). A per-session fallback worker (service unavailable) still closes after the same time without speech.
- **Protocol.** It never closes mid-request. Text may contain line breaks and tabs (CR/CRLF are normalized to LF); other control characters are rejected. Versions: a newer session replaces an older service (at most one replacement per 30 s, prereleases ordered per semver); an older session never does, it uses the newer service when the protocol matches, otherwise its own local worker.
- **Recovery.** A killed service or a stale socket is detected and replaced by the next session; after an update of this package the outdated service is asked to exit and is replaced. If the service cannot run, the session falls back to its own per-session worker (one note in the log, never an error).
- **Log.** `~/.gentle-speak/qwen-service.log` (rotated at 512 KB when the service starts).
- **Stop it.** `/speak` → `Detener servicio Qwen`, or `kill $(cat ~/.gentle-speak/qwen-service.pid)`. The next Qwen speech starts it again.

#### Speaks faster (Qwen voices)

While the answer is being written, a Qwen voice already synthesizes its completed sentences (at most 500 characters ahead); nothing plays before the answer is final. When the run settles, the audio that matches the final spoken text plays at once and only the rest is synthesized. It applies to automatic speech in the interactive parent TUI, not to `summary` mode, Piper voices, copied-selection speech or the speak-last key. Tool-call turns, stop, toggle off, a voice change and shutdown delete the prepared audio. When focus is unknown and the project prefix applies, prepared audio is discarded and the prefixed text is synthesized normally, because prepared audio has no prefix. An unfocused pane keeps only the latest result, prepared audio included.

#### Mac voice (extra voice and fallback)

macOS only, nothing to download or install: the `Mac` voice speaks through `/usr/bin/say`, with the text on stdin (never in the command line), so it needs neither the Piper/Qwen runtime nor node-cpal. It takes the same voice lock, deferral and stop key as every voice, never speculates, and speed maps to the say rate `round(185 × speed)` words per minute.

- **Voice.** `/speak` → `Mac voice` lists the installed Spanish voices (`say -v '?'`) or `Auto`. Auto (`macVoice: null`) picks `Paulina` (es_MX), then `Mónica` (es_ES), then the first es_MX voice, then the first `es_*` voice. The SPEAK row shows `Mac · <voice>`, and the `cycleVoice` key includes `Mac` when `say` exists.
- **Fallback.** With `macFallback` on (the default; `/speak` → `Toggle Mac fallback`), a Piper or Qwen voice that is not installed, or whose runtime or worker fails to start or synthesize, speaks the same text with the Mac voice, and you are told once per session. A cancel, a stop, invalid text and the parent-session refusal never fall back. Off macOS, or without `say`, there is no Mac voice and the usual errors stand.
- **Settings.** `macVoice` (a voice name or `null`) and `macFallback` (boolean); old settings files stay valid.

#### Speak copied selection

Off by default. `/speak` → `Toggle speak copied selection` speaks, with the current voice, text you select and copy in this Gentle Shell (copy-on-release). It needs macOS and the fullscreen TUI; otherwise it reports "unavailable in this terminal mode" and does not start. Privacy: only copies made in this Gentle Shell are spoken (the terminal app must be frontmost and the text must be the visible selection); concealed, transient and password-manager copies are skipped; clipboard text is never stored or logged.

#### Several sessions (Herdr panes, several harnesses)

- **One voice.** Every playback, Piper or Qwen, takes a lock under `~/.gentle-speak/` for its whole duration, so sessions take turns and never talk over each other. A lock whose owner process died is reclaimed. Your stop key only stops your own session.
- **Focus with deferral.** A session speaks at once when its pane is focused: the terminal app is frontmost and Herdr (`HERDR_ENV=1`, `herdr pane get $HERDR_PANE_ID`) reports the pane focused. When it is not, only the latest result of that session is kept and spoken once you focus the pane (checked about once a second, only while something is pending). It is dropped on toggle off, stop, `/reload` and shutdown. This applies to automatic speech and the `speak` tool; the speak-last key and copied-selection speech are your own action, so they speak immediately (still one voice at a time).
- **Focus unknown.** Outside Herdr, on a system other than macOS, when the terminal cannot be identified, or when the Herdr CLI fails or times out, speech takes its turn and starts with the project name: `gentle-theme: …`.
- `HERDR_BIN_PATH` is honored only when it is an absolute path ending in `herdr`; otherwise `herdr` from `PATH` is used.

### Gentle Dot

gentle-speak can also speak inside Gentle Dot's own engine, with no change to Gentle Dot. Dot runs an isolated `gentle-shell --mode rpc` whose agent dir is `GENTLE_DOT_AGENT_HOME` (default `~/.gentle-dot/agent`) and whose `HOME` is its own `<dataDir>/home` (derived as `dirname(<Dot agent home>)/home`; `GENTLE_DOT_HOME` overrides it).

- **Dot has its own configuration.** Dot reads `speak-settings.json` from `$HOME/.gentle-speak`, which inside Dot is `<dotHome>/.gentle-speak/speak-settings.json` (mode 0600, directory 0700). Dot speaks only when that file has `enabled: true`; a missing or malformed file means off. The terminal's `dotSpeech` is still accepted when loading old settings but is ignored.
- **Shared and not shared.** Shared from the real home `~/.gentle-speak`: the audio runtime, Piper models, Qwen voices and manifests, the cross-process voice lock (so Dot and the terminal never overlap) and the Qwen child's real `HOME`. Not shared, per app: the settings file (enabled, voice, mode, speed, summary model, Mac preferences). In a terminal both homes are the same directory.
- **One-time offer.** On startup of an interactive terminal session, if Dot's home has a `settings.json` without gentle-speak in its `packages`, you are asked once: «Encontré Gentle Dot. ¿Querés que también hable ahí?». The offer never appears inside Dot, in child sessions, or in RPC/print mode. **No** is remembered (`dotOffer: "declined"`).
- **Connect.** **Yes** (or `/speak` → `Gentle Dot` → `Conectar Gentle Dot`, which does not ask again) backs up Dot's `settings.json` as `settings.json.gentle-speak-backup-<timestamp>`, adds this terminal's gentle-speak source to its `packages` (a local path is written absolute; an npm or git source is copied as is). Accepted sources, nothing else: an absolute (or `~`/relative, resolved for Dot) local directory whose `package.json` name is `gentle-speak`; `npm:gentle-speak[@version]`; a git source of a repository named `gentle-speak` in the forms Pi documents, `git:<host>/<owner>/gentle-speak[.git][@ref]` or `https://<host>/<owner>/gentle-speak[.git][@ref]` (`@ref` of letters, digits, `.`, `_`, `/`, `-`, up to 100). Credentials, query strings, fragments, `ssh:`/`file:`/`git@` forms (Pi documents none), other repository names, other npm names and nonexistent local paths are refused with a notice and nothing is written, keeps every other key, and writes atomically. It then creates Dot's speak settings copying the terminal's voice, mode, speed, summary model and Mac preferences, with `enabled: true` and `copySpeech: false`; if that file already exists only `enabled` is set to `true`. A `settings.json` or speak settings file that is not valid is never written; you are told instead.
- **Disconnect.** `Desconectar Gentle Dot` backs up Dot's `settings.json`, removes only the gentle-speak entry and sets Dot's `enabled: false`; Dot's settings file is kept.
- **Terminal submenu `/speak` → `Gentle Dot`.** Its title shows the state (not found, malformed, connected or not, speaks yes/no, voice, mode). Actions: `Conectar Gentle Dot`, `Desconectar Gentle Dot`, `Hablar en Dot` (toggles Dot's `enabled`), `Voz de Dot` (the same catalog, Mac included) and `Modo de Dot`. Each writes Dot's settings atomically with the same schema and refuses a malformed file with a notice. Voice and mode changes apply to Dot's next utterance; connect/disconnect need a Dot restart.
- **Mute Dot's own voice.** Dot replies with its own text-to-speech; turn that off in Dot, or you will hear every answer twice. Then restart Dot so its engine loads the package.
- **What speaks.** Only Dot's root RPC session, with the same voice, mode, filter, Qwen speculation and cross-process voice lock as the terminal. It takes its turn at once (no focus deferral) and every text starts with `Dot: `. It never speaks in other RPC clients, child sessions, print or JSON mode, and shows no SPEAK row, shortcuts or copy speech (there is no TUI there). `GENTLE_SPEAK_DOT=1` also marks a session as Dot's.

## Platform, licenses and verification

Supported runtime targets: macOS x64/arm64, Linux x64/arm64 (glibc ≥2.34 for native binaries), Windows x64; other platforms are unsupported. The extension installs its own sherpa-onnx-node / node-cpal runtime, independently of Gentle Shell dictation. Converted voice bundles come from [sherpa-onnx TTS model releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models); retain each installed model's `MODEL_CARD` and check dataset/voice rights before redistribution. The es_MX Claude model card identifies Apache-2.0 dataset attribution; es_ES Davefx identifies CC0. Repository code is [MIT](LICENSE); sherpa-onnx-node/platform binaries are Apache-2.0, bundled onnxruntime MIT, and node-cpal ISC with Rust dependencies. Runtime tarballs do not contain all bundled LICENSE/NOTICE texts; resolve notices before distributing a combined runtime.

Local macOS arm64 tests returned worker `done` for both voices without protocol errors. In one interactive Gentle Shell session, a human confirmed audible playback from the manual `speak` tool using `es_MX`; another attempt returned `Audio playback failed`, so repeated playback is not yet reliable. Physical audibility of `es_ES` and other platforms has **not** been verified. Independent archive/installer audit timed out without a verdict, and automatic speech, shortcuts, and summary-provider integration remain unverified in a live TUI. Do not treat this package as publication-ready until those checks pass. No public repository topics, PR, npm publish, or Hub listing are claimed.

## Development

Run `npm test` with Node.js 24+. See [CHANGELOG.md](CHANGELOG.md) for the local candidate history.
