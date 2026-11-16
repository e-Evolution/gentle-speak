# Contributing to gentle-speak

Thanks for helping. Bug reports, platform reports and pull requests are welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Reports from Linux and Windows are especially useful: those platforms are tested with fakes in CI but have not been checked on real machines yet.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

You need Node.js 24 or newer.

```bash
git clone https://github.com/e-Evolution/gentle-speak.git
cd gentle-speak
npm ci
npm test
```

To try your checkout inside Gentle Shell without installing it:

```bash
gentle-shell -- -e ./extensions/gentle-speak.ts
```

## Tests

- `npm test` runs the whole suite with `node --test`.
- The suite runs behind a real-home guard. Tests must use injected temporary homes and fail if they read or write the real `~/.gentle-speak`, `~/.gentle-dot`, `~/.gentle-shell` or `~/.pi`. Never weaken the guard to make a test pass.
- Use fakes for processes, audio devices, the clipboard and the network. Tests must not download anything or play sound.
- For a behaviour change, add a test that fails before your change and passes after it.

## Code conventions

- TypeScript run directly by Node (`--experimental-strip-types`), with no build step.
- Spawn processes with an argument array, never a shell string.
- Every source file under `extensions/`, `lib/`, `scripts/` and `tests/` starts with the MIT header used in the existing files. `tests/license-headers.test.ts` checks it.
- Keep user-facing text in `/speak` consistent with the existing menus.

## Pull requests

- One topic per pull request, with tests and docs in the same change.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example `fix(speak): ...` or `docs: ...`.
- Update `README.md` when you change a command, an option or a message, and add a line to `CHANGELOG.md`.
- CI must pass on macOS, Linux and Windows.

By contributing, you agree that your contribution is licensed under the MIT license of this project.
