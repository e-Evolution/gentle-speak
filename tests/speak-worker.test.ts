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
