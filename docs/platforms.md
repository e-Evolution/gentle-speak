---
title: Platforms
nav_order: 8
translation: es/plataformas.md
---

# Platforms

## What is verified

- **CI** runs the whole test suite on macOS, Linux and Windows, with Node.js 24. The tests use fakes for processes, audio devices, the clipboard and the network.
- **Live checks** of audio, focus and the system voice have been done only on **macOS on Apple Silicon**.
- **Linux and Windows are not verified live.** Their system-voice flags (`spd-say`, `espeak-ng`, SAPI) come from the tools' documentation. Intel macOS is untested.
- **Qwen voices are Apple Silicon only.**

Reports from real Linux and Windows machines are welcome; see [Contributing](contributing.md).

## Feature table

| Feature | macOS arm64 | macOS Intel | Linux | Windows |
|---------|:-----------:|:-----------:|:-----:|:-------:|
| Piper (native runtime) | ✓ | runtime target exists | x64 and arm64 targets, fakes only | x64 target, fakes only |
| Qwen3-TTS | ✓ | ✗ (Apple Silicon only) | ✗ | ✗ |
| System voice | ✓ (`say`) | ✓ (`say`) | fakes only | fakes only |
| Copy speech | ✓ | ✓ | ✗ | ✗ |
| Terminal focus events | ✓ | ✓ | ✓ if the terminal sends them | ✓ if the terminal sends them |
| Herdr focus | ✓ (where Herdr runs) | same | same | same |
| Gentle Dot | ✓ | untested | untested | untested |

✓ means it works on that platform, and only macOS arm64 has been run live. "Fakes only" means the code path exists and is tested with fakes in CI, but has not been run on a real machine.

## Platform notes

- **Native runtime targets:** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` and `win32-x64`. On other platforms the runtime cannot be installed.
- **Linux:** the prebuilt native binaries need glibc 2.34 or newer. This is an upstream requirement; gentle-speak does not check it. The system voice needs `sudo apt install speech-dispatcher espeak-ng` (or your distribution's package manager).
- **Linux `spd-say`:** stopping speech (or a timeout) runs `spd-say -C`, which cancels everything speech-dispatcher has queued, including other applications' speech. It cannot cancel only gentle-speak's. Not verified live.
- **Windows** needs `powershell.exe` on `PATH` for the system voice; without it the system voice is reported as unavailable. Listing the voices is bounded to 8 seconds, and a listing that does not answer counts as no voices.
- **Copy speech** is the only feature that needs macOS, and it also needs the fullscreen TUI. On Linux and Windows the rest of gentle-speak works; copy speech is reported as unavailable.
