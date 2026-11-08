# gentle-speak

A planned local text-to-speech extension for Pi / Gentle Shell. **Speech and controls are not yet implemented.** This initial package only exports an inert Pi extension: installing or loading it does not download a model, start a worker, or play audio.

## Status

Not yet implemented: automatic reading of questions and usable results, `/speak` settings, keyboard shortcuts, model-callable speech, local TTS runtime, and configurable Spanish `es_MX` / `es_ES` voices. The planned default is off; the independent speech runtime will require an explicit installation flow. Do not install this version expecting audio playback.

The gallery preview declared in package metadata is pending and will be added before publication. The changelog and public repository topics are also pending.

## Development

Requires Node.js 24 or later. Run `npm test` (or `node --experimental-strip-types --test tests/*.test.ts`) for the package scaffold checks. No install or download is needed for these tests.

## License

MIT; see [LICENSE](LICENSE).
