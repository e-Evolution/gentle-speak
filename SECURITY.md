# Security policy

## Supported versions

Only the latest released version of gentle-speak receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- the affected version and platform;
- the steps to reproduce;
- what an attacker could do with it.

You should get a first answer within 7 days. Once a fix is released, the advisory is published with credit to the reporter, unless you prefer to stay anonymous.

## Scope

gentle-speak downloads and runs third-party components on the user's machine. These areas are in scope:

- the downloads and their pinned hashes, and archive extraction;
- the Python environment setup;
- the local Qwen service socket under `~/.gentle-speak`;
- importing a user's voice recording;
- anything that could make gentle-speak read aloud, copy or send data the user did not choose.

Vulnerabilities in the upstream projects themselves (sherpa-onnx, mlx-audio, Piper voices, Qwen3-TTS models, Gentle Shell) belong to those projects. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for their sources.
