---
title: Contributing
nav_order: 13
translation: es/contribuir.md
---

# Contributing

Bug reports, platform reports and pull requests are welcome. Reports from real Linux and Windows machines are especially useful: those platforms are tested with fakes in CI but have not been checked live yet.

- **How to contribute:** read [CONTRIBUTING.md](https://github.com/e-Evolution/gentle-speak/blob/main/CONTRIBUTING.md). It covers the development setup, the tests and their real-home guard, the code conventions and pull requests.
- **Bugs and ideas:** open an [issue](https://github.com/e-Evolution/gentle-speak/issues). Include the `/speak doctor` output and your platform. For anything bigger than a small fix, open an issue first so we can agree on the approach.
- **History:** see [CHANGELOG.md](https://github.com/e-Evolution/gentle-speak/blob/main/CHANGELOG.md).

## Development in short

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

## Report a vulnerability

Do not open a public issue for a security problem. Follow [SECURITY.md](https://github.com/e-Evolution/gentle-speak/blob/main/SECURITY.md): open the repository's **Security** tab and choose **Report a vulnerability**. See also [Privacy and security](privacy.md#reporting-a-vulnerability).

By contributing, you agree that your contribution is licensed under the MIT license of this project.
