import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runSpeakWorker } = require('../scripts/speak-worker.cjs');
const schema = 'gentle.speak/v1';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(run: (runtime: string, model: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'speak-worker-'));
  try {
    const runtime = join(root, 'runtime'), model = join(root, 'model');
    for (const p of ['node_modules/sherpa-onnx-node/non-streaming-tts.js', 'node_modules/node-cpal/index.js']) {
      const dest = join(runtime, p); await mkdir(join(dest, '..'), { recursive: true }); await writeFile(dest, 'mock');
    }
    await mkdir(model); await writeFile(join(model, 'voice.onnx'), 'mock');
    await writeFile(join(model, 'tokens.txt'), 'mock'); await mkdir(join(model, 'espeak-ng-data'));
    await run(runtime, model);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const speak = (runtime: string, model: string, id = 1) => ({ schema, type: 'speak', id, text: 'hola', speed: 1, runtime, model: { root: model, name: 'voice.onnx' } });
function harness(loadModule = () => { throw Error('unexpected load'); }) {
  const input = new PassThrough(); const lines: any[] = []; const exits: number[] = [];
  const done = runSpeakWorker({ input, write: (line: string) => lines.push(JSON.parse(line)), exit: (code: number) => exits.push(code), loadModule });
  const send = (value: unknown) => input.write(JSON.stringify(value) + '\n');
  return { input, lines, exits, done, send };
}
test('idle and shutdown never load native code', async () => {
  const h = harness(); await tick(); assert.deepEqual(h.lines, []); h.input.end(); await h.done;
  assert.deepEqual(h.exits, [0]);
});
test('explicit speech plays mono samples on a mocked output device and closes resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'speak-worker-'));
  try {
    const runtime = join(root, 'runtime'), model = join(root, 'model');
    for (const p of ['node_modules/sherpa-onnx-node/non-streaming-tts.js', 'node_modules/node-cpal/index.js']) {
      const dest = join(runtime, p); await mkdir(join(dest, '..'), { recursive: true }); await writeFile(dest, 'mock');
    }
    await mkdir(model); await writeFile(join(model, 'voice.onnx'), 'mock');
    await writeFile(join(model, 'tokens.txt'), 'mock'); await mkdir(join(model, 'espeak-ng-data'));
    const events: string[] = [];
    const h = harness((p: string) => p.includes('sherpa-onnx-node') ? { OfflineTts: class {
      constructor(config: any) { assert.deepEqual(config.model.vits, { model: join(model, 'voice.onnx'), tokens: join(model, 'tokens.txt'), dataDir: join(model, 'espeak-ng-data'), lengthScale: 1 }); }
      async generateAsync(request: any) { assert.equal(request.text, 'hola'); return { samples: new Float32Array([0.25, -0.5]), sampleRate: 16000 }; }
    } } : { SampleFormat: { F32: 'f32' }, defaultHost() { return { close() { events.push('host-close'); }, defaultOutputDevice() { return {
      supportedOutputConfigs() { return [{ sampleFormat: () => 'f32', containsRate: () => true, tryWithSampleRate: () => ({ config: () => ({ channels: 2, sampleRate: 16000 }) }) }]; },
      buildOutputStream(_config: any, _format: any, callback: any) { return { play() { const data = new Float32Array(4); callback(data); assert.deepEqual([...data], [0.25, 0.25, -0.5, -0.5]); callback(new Float32Array(4)); }, close() { events.push('stream-close'); } }; }, close() { events.push('device-close'); }
    }; } }; } });
    h.send({ schema, type: 'speak', id: 1, text: 'hola', speed: 1, runtime, model: { root: model, name: 'voice.onnx' } });
    await tick(); await tick(); h.send({ schema, type: 'shutdown' }); await h.done;
    assert.deepEqual(h.lines, [{ schema, type: 'done', id: 1 }]); assert.deepEqual(events, ['stream-close', 'device-close', 'host-close']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('22050 Hz synthesis resamples to supported 48000 Hz F32 output without changing duration', async () => fixture(async (runtime, model) => {
  const samples = Float32Array.from({ length: 2205 }, (_, i) => i / 2204);
  const events: string[] = [];
  const h = harness((p: string) => p.includes('sherpa-onnx-node') ? { OfflineTts: class {
    async generateAsync() { return { samples, sampleRate: 22050 }; }
  } } : { SampleFormat: { F32: 'f32' }, defaultHost() { return {
    defaultOutputDevice() { return {
      supportedOutputConfigs() { return [{ sampleFormat: () => 'f32', containsRate: (rate: number) => rate === 48000,
        tryWithSampleRate: (_rate: number) => null, tryWithStandardSampleRate: () => ({ config: () => ({ channels: 2, sampleRate: 48000 }) }) }]; },
      buildOutputStream(config: any, _format: any, callback: any) { assert.equal(config.sampleRate, 48000); return {
        play() { const first = new Float32Array(9600); callback(first);
          assert.equal(first[0], 0); assert.equal(first[1], 0);
          assert.ok(first[4800] > 0.49 && first[4800] < 0.51);
          assert.ok(first[9598] > 0.99); assert.equal(first[9598], first[9599]);
          assert.deepEqual(h.lines, []); callback(new Float32Array(2)); },
        close() { events.push('stream'); }
      }; }, close() { events.push('device'); }
    }; }, close() { events.push('host'); }
  }; } });
  h.send(speak(runtime, model)); await tick(); await tick();
  assert.deepEqual(h.lines, [{ schema, type: 'done', id: 1 }]);
  assert.deepEqual(events, ['stream', 'device', 'host']);
  h.send({ schema, type: 'shutdown' }); await h.done;
}));
test('missing or wrong-kind VITS assets reject before native load', async () => fixture(async (runtime, model) => {
  let loads = 0;
  for (const missing of ['tokens.txt', 'espeak-ng-data']) {
    const target = join(model, missing);
    await rm(target, { recursive: true });
    const h = harness(() => { loads++; throw Error('native load'); });
    h.send(speak(runtime, model)); await tick();
    assert.deepEqual(h.lines, [{ schema, type: 'error', code: 'playback', id: 1 }]);
    h.send({ schema, type: 'shutdown' }); await h.done;
    if (missing === 'tokens.txt') await writeFile(target, 'mock');
  }
  assert.equal(loads, 0);
}));
test('stop during pending synthesis starts the next request without waiting for the old promise', async () => fixture(async (runtime, model) => {
  let first = true;
  const h = harness((p: string) => p.includes('sherpa-onnx-node') ? { OfflineTts: class {
    generateAsync() { if (first) { first = false; return new Promise(() => {}); } return Promise.reject(Error('second reached')); }
  } } : {});
  h.send(speak(runtime, model)); await tick(); h.send({ schema, type: 'stop' }); h.send(speak(runtime, model, 2));
  await tick(); await tick();
  assert.deepEqual(h.lines, [{ schema, type: 'stopped' }, { schema, type: 'error', code: 'playback', id: 2 }]);
  h.send({ schema, type: 'shutdown' }); await h.done; assert.deepEqual(h.exits, [0]);
}));
test('device acquisition failure closes host before reporting error', async () => fixture(async (runtime, model) => {
  const events: string[] = [];
  const h = harness((p: string) => p.includes('sherpa-onnx-node') ? { OfflineTts: class {
    async generateAsync() { return { samples: new Float32Array([1]), sampleRate: 16000 }; }
  } } : { defaultHost() { return { defaultOutputDevice() { throw Error('device'); }, close() { events.push('host-close'); } }; } });
  h.send(speak(runtime, model)); await tick(); await tick();
  assert.deepEqual(h.lines, [{ schema, type: 'error', code: 'playback', id: 1 }]); assert.deepEqual(events, ['host-close']);
  h.send({ schema, type: 'shutdown' }); await h.done;
}));
test('shutdown closes stream, device and host before exit', async () => fixture(async (runtime, model) => {
  const events: string[] = []; let output: ((data: Float32Array) => void) | undefined;
  const h = harness((p: string) => p.includes('sherpa-onnx-node') ? { OfflineTts: class {
    async generateAsync() { return { samples: new Float32Array([1, 1]), sampleRate: 16000 }; }
  } } : { SampleFormat: { F32: 'f32' }, defaultHost() { return {
    defaultOutputDevice() { return {
      supportedOutputConfigs() { return [{ sampleFormat: () => 'f32', containsRate: () => true, tryWithSampleRate: () => ({ config: () => ({ channels: 1, sampleRate: 16000 }) }) }]; },
      buildOutputStream(_c: any, _f: any, cb: any) { output = cb; return { play() {}, close() { events.push('stream-close'); } }; },
      close() { events.push('device-close'); }
    }; }, close() { events.push('host-close'); }
  }; } });
  h.send(speak(runtime, model)); await tick(); await tick(); assert.ok(output);
  h.send({ schema, type: 'shutdown' }); await h.done;
  assert.deepEqual(events, ['stream-close', 'device-close', 'host-close']); assert.deepEqual(h.exits, [0]); assert.deepEqual(h.lines, []);
}));
test('submitting final buffer does not report audible completion before drain', async () => fixture(async (runtime, model) => {
  let output: ((data: Float32Array) => void) | undefined; const events: string[] = [];
  const h = harness((p: string) => p.includes('sherpa-onnx-node') ? { OfflineTts: class {
    async generateAsync() { return { samples: new Float32Array([0.5]), sampleRate: 16000 }; }
  } } : { SampleFormat: { F32: 'f32' }, defaultHost() { return {
    defaultOutputDevice() { return {
      supportedOutputConfigs() { return [{ sampleFormat: () => 'f32', containsRate: () => true, tryWithSampleRate: () => ({ config: () => ({ channels: 1, sampleRate: 16000 }) }) }]; },
      buildOutputStream(_c: any, _f: any, cb: any) { output = cb; return { play() {}, close() { events.push('stream-close'); } }; }, close() { events.push('device-close'); }
    }; }, close() { events.push('host-close'); }
  }; } });
  h.send(speak(runtime, model)); await tick(); await tick(); assert.ok(output);
  output!(new Float32Array(1)); await tick();
  assert.deepEqual(h.lines, []); assert.deepEqual(events, []);
  h.send({ schema, type: 'stop' }); await tick();
  assert.deepEqual(h.lines, [{ schema, type: 'stopped' }]);
  h.send({ schema, type: 'shutdown' }); await h.done;
}));
test('shutdown is bounded even when synthesis never resolves', async () => fixture(async (runtime, model) => {
  const h = harness((p: string) => p.includes('sherpa-onnx-node') ? { OfflineTts: class {
    generateAsync() { return new Promise(() => {}); }
  } } : {});
  h.send(speak(runtime, model)); await tick(); h.send({ schema, type: 'shutdown' });
  await Promise.race([h.done, new Promise((_, reject) => setTimeout(() => reject(Error('shutdown hung')), 100))]);
  assert.deepEqual(h.exits, [0]); assert.deepEqual(h.lines, []);
}));
test('malformed request rejects with closed error and never loads', async () => {
  const h = harness(); h.send({ schema, type: 'speak', text: 'hola', runtime: '../../unsafe' }); await h.done;
  assert.deepEqual(h.lines, [{ schema, type: 'error', code: 'invalid-request' }]); assert.deepEqual(h.exits, [1]);
});

// ---- play message (T11): PCM16 mono WAV through the same cpal output path ----
function wavBytes(samples: number[], rate = 16000, over: { channels?: number; bits?: number; format?: number } = {}) {
  const data = Buffer.alloc(samples.length * 2); samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(over.format ?? 1, 20); header.writeUInt16LE(over.channels ?? 1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(over.bits ?? 16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const cpalMock = (events: string[], received: Float32Array[]) => ({ SampleFormat: { F32: 'f32' }, defaultHost() { return { close() { events.push('host'); }, defaultOutputDevice() { return {
  supportedOutputConfigs() { return [{ sampleFormat: () => 'f32', containsRate: () => true, tryWithSampleRate: () => ({ config: () => ({ channels: 1, sampleRate: 16000 }) }) }]; },
  buildOutputStream(_c: any, _f: any, callback: any) { return { play() { const data = new Float32Array(4); callback(data); received.push(data); callback(new Float32Array(4)); }, close() { events.push('stream'); } }; }, close() { events.push('device'); },
}; } }; } });
async function playFixture(run: (runtime: string, dir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'speak-play-'));
  try {
    const runtime = join(root, 'runtime'); const dest = join(runtime, 'node_modules/node-cpal/index.js');
    await mkdir(join(dest, '..'), { recursive: true }); await writeFile(dest, 'mock');
    await run(runtime, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const play = (wav: string, runtime: string, id = 1, speed = 1) => ({ schema, type: 'play', id, wav, speed, runtime });

test('play accepts a valid PCM16 mono WAV, resamples through the shared output and reports done', async () => playFixture(async (runtime, dir) => {
  const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([16384, -16384]));
  const events: string[] = []; const received: Float32Array[] = [];
  const h = harness(() => cpalMock(events, received));
  h.send(play(wav, runtime)); await tick(); await tick();
  assert.deepEqual(h.lines, [{ schema, type: 'done', id: 1 }]);
  assert.deepEqual([...received[0].subarray(0, 2)], [0.5, -0.5]);
  assert.deepEqual(events, ['stream', 'device', 'host']);
  h.send({ schema, type: 'shutdown' }); await h.done;
}));
test('play rejects a non-absolute or unnormalized path before touching the file system', async () => playFixture(async (runtime) => {
  for (const wav of ['relative.wav', '/tmp/../etc/a.wav']) {
    const h = harness(() => { throw Error('unexpected load'); });
    h.send(play(wav, runtime)); await tick();
    assert.deepEqual(h.lines, [{ schema, type: 'error', code: 'invalid-request' }]);
    assert.deepEqual(h.exits, [1]); await h.done;
  }
}));
test('play rejects extra keys, bad speed and bad id like speak does', async () => playFixture(async (runtime, dir) => {
  for (const bad of [{ ...play(join(dir, 'a.wav'), runtime), extra: 1 }, play(join(dir, 'a.wav'), runtime, 1, 9), play(join(dir, 'a.wav'), runtime, -1)]) {
    const h = harness(() => { throw Error('unexpected load'); });
    h.send(bad); await tick();
    assert.deepEqual(h.lines, [{ schema, type: 'error', code: 'invalid-request' }]); await h.done;
  }
}));
test('play reports a playback error for non-WAV bytes, unsupported format, bad rate and oversize duration, without crashing', async () => playFixture(async (runtime, dir) => {
  const cases: Record<string, Buffer> = {
    'text.wav': Buffer.from('this is definitely not a wav file at all, just text'),
    'stereo.wav': wavBytes([1, 2, 3, 4], 16000, { channels: 2 }),
    'eight.wav': wavBytes([1, 2], 16000, { bits: 8 }),
    'float.wav': wavBytes([1, 2], 16000, { format: 3 }),
    'lowrate.wav': wavBytes([1, 2], 7999),
    'highrate.wav': wavBytes([1, 2], 384001),
    'long.wav': wavBytes(new Array(8000 * 120 + 1).fill(0), 8000),
    'empty.wav': wavBytes([]),
  };
  const h = harness(() => cpalMock([], []));
  let id = 0;
  for (const [name, bytes] of Object.entries(cases)) {
    await writeFile(join(dir, name), bytes); id++;
    h.send(play(join(dir, name), runtime, id)); await tick(); await tick();
    assert.deepEqual(h.lines.at(-1), { schema, type: 'error', code: 'playback', id }, name);
  }
  h.send(play(join(dir, 'missing.wav'), runtime, 99)); await tick(); await tick();
  assert.deepEqual(h.lines.at(-1), { schema, type: 'error', code: 'playback', id: 99 });
  h.send({ schema, type: 'shutdown' }); await h.done; assert.deepEqual(h.exits, [0]);
}));
test('stop during play drops queued plays', async () => playFixture(async (runtime, dir) => {
  const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([1, 2, 3]));
  const h = harness(() => ({ SampleFormat: { F32: 'f32' }, defaultHost() { return { close() {}, defaultOutputDevice() { return {
    supportedOutputConfigs() { return [{ sampleFormat: () => 'f32', containsRate: () => true, tryWithSampleRate: () => ({ config: () => ({ channels: 1, sampleRate: 16000 }) }) }]; },
    buildOutputStream() { return { play() {}, close() {} }; }, close() {} }; } }; } }));
  h.send(play(wav, runtime, 1)); h.send(play(wav, runtime, 2)); h.send(play(wav, runtime, 3)); await tick();
  h.send({ schema, type: 'stop' }); await tick(); await tick();
  assert.deepEqual(h.lines, [{ schema, type: 'stopped' }]);
  h.send({ schema, type: 'shutdown' }); await h.done;
}));

// T21: playback opens the device's own default output config so CoreAudio is never asked to change the sample rate.
const supportedAt = (rate: number, channels = 1) => ({ sampleFormat: () => 'f32', containsRate: () => true, tryWithSampleRate: () => ({ config: () => ({ channels, sampleRate: rate }) }) });
function deviceCpal(opts: { dflt?: () => any; supported?: any[]; build?: (config: any, cb: any, onError: any) => any; opened: any[]; received: Float32Array[]; frame?: number }) {
  return { SampleFormat: { F32: 'f32' }, defaultHost() { return { close() {}, defaultOutputDevice() { return {
    ...(opts.dflt ? { defaultOutputConfig: opts.dflt } : {}),
    supportedOutputConfigs() { return opts.supported ?? [supportedAt(22050)]; },
    buildOutputStream(config: any, _f: any, callback: any, onError: any) {
      opts.opened.push(config);
      if (opts.build) return opts.build(config, callback, onError);
      return { play() { const data = new Float32Array(opts.frame ?? 8); callback(data); opts.received.push(data); callback(new Float32Array(opts.frame ?? 8)); }, close() {} };
    }, close() {},
  }; } }; } };
}
const defaultConfig = (channels: number, sampleRate: number, format = 'f32') => () => ({ sampleFormat: () => format, config: () => ({ channels, sampleRate }) });

test('play opens the device default config (no sample-rate change) and resamples to it', async () => playFixture(async (runtime, dir) => {
  const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([16384, -16384, 16384, -16384], 22050));
  const opened: any[] = [], received: Float32Array[] = [];
  const h = harness(() => deviceCpal({ dflt: defaultConfig(2, 24000), supported: [supportedAt(22050)], opened, received }));
  h.send(play(wav, runtime)); await tick(); await tick();
  assert.deepEqual(h.lines, [{ schema, type: 'done', id: 1 }]);
  assert.deepEqual(opened, [{ channels: 2, sampleRate: 24000 }]);
  const out = [...received[0]];
  assert.equal(out[0], 0.5); assert.equal(out[1], 0.5);
  // frame 1 sits at source position 22050/24000 = 0.91875 between 0.5 and -0.5 -> linear interpolation, duplicated per channel
  const expected = 0.5 + (-0.5 - 0.5) * (22050 / 24000);
  assert.ok(Math.abs(out[2] - expected) < 1e-6 && out[2] === out[3]);
  h.send({ schema, type: 'shutdown' }); await h.done;
}));
test('play uses the default config unchanged when its rate already equals the WAV rate', async () => playFixture(async (runtime, dir) => {
  const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([16384, -16384], 16000));
  const opened: any[] = [], received: Float32Array[] = [];
  const h = harness(() => deviceCpal({ dflt: defaultConfig(1, 16000), supported: [supportedAt(48000)], opened, received, frame: 2 }));
  h.send(play(wav, runtime)); await tick(); await tick();
  assert.deepEqual(h.lines, [{ schema, type: 'done', id: 1 }]);
  assert.deepEqual(opened, [{ channels: 1, sampleRate: 16000 }]);
  assert.deepEqual([...received[0]], [0.5, -0.5]);
  h.send({ schema, type: 'shutdown' }); await h.done;
}));
test('play falls back to the supported-config search when the default config is missing, throws or is not F32', async () => playFixture(async (runtime, dir) => {
  const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([16384, -16384], 16000));
  for (const dflt of [undefined, () => { throw Error('no default'); }, defaultConfig(2, 24000, 'i16')]) {
    const opened: any[] = [], received: Float32Array[] = [];
    const h = harness(() => deviceCpal({ dflt, supported: [supportedAt(16000)], opened, received, frame: 2 }));
    h.send(play(wav, runtime)); await tick(); await tick();
    assert.deepEqual(h.lines, [{ schema, type: 'done', id: 1 }]);
    assert.deepEqual(opened, [{ channels: 1, sampleRate: 16000 }]);
    h.send({ schema, type: 'shutdown' }); await h.done;
  }
}));
test('a stream failure replies with its code and a bounded, path-free cause', async () => playFixture(async (runtime, dir) => {
  const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([16384, -16384], 16000));
  const throwing = (message: string) => () => deviceCpal({ dflt: defaultConfig(1, 24000), opened: [], received: [], build: () => { throw Object.assign(Error(message), { name: 'CpalError' }); } });
  const cases: Array<[string, string]> = [
    ['Sample rate update timed out', 'Sample rate update timed out'],
    ['failed at /Users/someone/secret/dir/file.node now', 'failed at now'],
    ['x'.repeat(500), 'x'.repeat(120)],
  ];
  let id = 0;
  for (const [message, cause] of cases) {
    const h = harness(throwing(message)); id++;
    h.send(play(wav, runtime, id)); await tick(); await tick();
    assert.deepEqual(h.lines, [{ schema, type: 'error', code: 'playback', id, cause }], message.slice(0, 30));
    h.send({ schema, type: 'shutdown' }); await h.done;
  }
  const failing = harness(() => deviceCpal({ dflt: defaultConfig(1, 24000), opened: [], received: [], build: (_c, _cb, onError) => ({ play() { onError(Error('device lost')); }, close() {} }) }));
  failing.send(play(wav, runtime, 9)); await tick(); await tick();
  assert.deepEqual(failing.lines, [{ schema, type: 'error', code: 'playback', id: 9, cause: 'device lost' }]);
  failing.send({ schema, type: 'shutdown' }); await failing.done;
}));

test('a throwing default config falls back to the supported-config search once, keeping the bounded cause on a second failure', async () => playFixture(async (runtime, dir) => {
  const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([16384, -16384], 16000));
  const opened: any[] = [], received: Float32Array[] = [];
  const first = harness(() => deviceCpal({ dflt: defaultConfig(1, 24000), supported: [supportedAt(16000)], opened, received, frame: 2,
    build: (config, cb) => { if (config.sampleRate === 24000) throw Object.assign(Error('Sample rate update timed out'), { name: 'CpalError' }); return { play() { const d = new Float32Array(2); cb(d); received.push(d); cb(new Float32Array(2)); }, close() {} }; } }));
  first.send(play(wav, runtime)); await tick(); await tick();
  assert.deepEqual(first.lines, [{ schema, type: 'done', id: 1 }]);
  assert.deepEqual(opened, [{ channels: 1, sampleRate: 24000 }, { channels: 1, sampleRate: 16000 }]);
  assert.deepEqual([...received[0]], [0.5, -0.5]);
  first.send({ schema, type: 'shutdown' }); await first.done;

  const bothOpened: any[] = [];
  const both = harness(() => deviceCpal({ dflt: defaultConfig(1, 24000), supported: [supportedAt(16000)], opened: bothOpened, received: [],
    build: () => { throw Object.assign(Error('Sample rate update timed out'), { name: 'CpalError' }); } }));
  both.send(play(wav, runtime, 2)); await tick(); await tick();
  assert.deepEqual(both.lines, [{ schema, type: 'error', code: 'playback', id: 2, cause: 'Sample rate update timed out' }]);
  assert.equal(bothOpened.length, 2); // exactly one fallback attempt, no loop
  both.send({ schema, type: 'shutdown' }); await both.done;
}));

// T27: non-fatal stream errors (xrun, device change, realtime denied) never abort playback.
const glitchCpal = (fire: (onError: any) => void) => () => deviceCpal({ dflt: defaultConfig(1, 24000), opened: [], received: [], build: (_c, cb, onError) => ({ play() { cb(new Float32Array(8)); fire(onError); cb(new Float32Array(8)); cb(new Float32Array(8)); }, close() {} }) });
const nonFatalCases: Array<[string, any]> = [
  ['XRUN', Object.assign(Error('A buffer underrun or overrun occurred.'), { code: 'XRUN' })],
  ['DEVICE_CHANGED', Object.assign(Error('The audio route changed.'), { code: 'DEVICE_CHANGED' })],
  ['REALTIME_DENIED', Object.assign(Error('whatever'), { code: 'REALTIME_DENIED' })],
  ['message-only xrun', Error('A buffer underrun or overrun occurred.')],
  ['message-only device change', Error('The audio route changed. The stream was automatically rerouted to a different device.')],
];
for (const [name, err] of nonFatalCases) {
  test(`a ${name} stream error mid-playback is non-fatal and ends in done`, async () => playFixture(async (runtime, dir) => {
    const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([16384, -16384], 16000));
    const h = harness(glitchCpal(onError => onError(err)));
    h.send(play(wav, runtime, 4)); await tick(); await tick();
    assert.deepEqual(h.lines, [{ schema, type: 'done', id: 4 }]);
    h.send({ schema, type: 'shutdown' }); await h.done;
  }));
}
test('other stream errors stay fatal, and a flood of xruns is capped into a playback error', async () => playFixture(async (runtime, dir) => {
  const wav = join(dir, 'a.wav'); await writeFile(wav, wavBytes([16384, -16384], 16000));
  const fatal = harness(glitchCpal(onError => onError(Object.assign(Error('The requested audio device is not available.'), { code: 'DEVICE_NOT_AVAILABLE' }))));
  fatal.send(play(wav, runtime, 5)); await tick(); await tick();
  assert.deepEqual(fatal.lines, [{ schema, type: 'error', code: 'playback', id: 5, cause: 'The requested audio device is not available.' }]);
  fatal.send({ schema, type: 'shutdown' }); await fatal.done;
  const flood = harness(() => deviceCpal({ dflt: defaultConfig(1, 24000), opened: [], received: [], build: (_c, _cb, onError) => ({ play() { for (let i = 0; i < 60; i++) onError(Object.assign(Error('A buffer underrun or overrun occurred.'), { code: 'XRUN' })); }, close() {} }) }));
  flood.send(play(wav, runtime, 6)); await tick(); await tick();
  assert.deepEqual(flood.lines, [{ schema, type: 'error', code: 'playback', id: 6, cause: 'A buffer underrun or overrun occurred.' }]);
  flood.send({ schema, type: 'shutdown' }); await flood.done;
}));
