import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import { QWEN_VOICES } from '../lib/speak-voices.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { createQwenSpeech } from '../lib/speak-qwen.ts';

const QS = 'gentle.speak.qwen/v1', AS = 'gentle.speak/v1';
const voice = QWEN_VOICES['qwen-intima'];
const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Resultado listo.' }] };
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setImmediate(r)); assert.ok(predicate(), 'condition not reached'); };
function fakeChild() {
  const writes: any[] = [];
  const child: any = Object.assign(new EventEmitter(), { stdin: { write: (line: string) => { writes.push(JSON.parse(line)); return true; } }, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0, kill() { child.killed++; return true; } });
  return { child, writes, emit: (m: object) => child.stdout.emit('data', JSON.stringify(m) + '\n') };
}
function harness(opts: { status?: any; voiceId?: string; manifest?: boolean; spawnFailures?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'speak-qwen-ext-'));
  const events = new Map<string, Function>(), shortcuts = new Map<string, any>(), tools = new Map<string, any>();
  const notifications: Array<[string, string]> = [];
  const pythons: Array<ReturnType<typeof fakeChild> & { python: string; script: string }> = [];
  const audios: Array<ReturnType<typeof fakeChild>> = [];
  const piperSpawns: string[] = [];
  let failures = opts.spawnFailures ?? 0;
  mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true });
  if (opts.manifest !== false) writeFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ python: '/fake/python3' }));
  writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, voice: opts.voiceId ?? 'qwen-intima', speed: 1.25 }));
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [{ type: 'message', message }] }, ui: { notify: (text: string, level: string) => notifications.push([text, level]) } };
  const dependencies = {
    modelStatus: async () => ({ state: 'installed', path: '/verified/model' }),
    runtimeStatus: async () => ({ state: 'installed', path: '/verified/runtime' }),
    qwenStatus: async () => opts.status ?? { manifest: 'valid', voices: { 'qwen-intima': 'installed' } },
    spawn: () => { const a = fakeChild(); if (opts.voiceId && opts.voiceId.startsWith('es_')) piperSpawns.push('piper'); audios.push(a); return a.child; },
    spawnQwen: (python: string, script: string) => { if (failures > 0) { failures--; throw new Error('spawn failed'); } const p = Object.assign(fakeChild(), { python, script }); pythons.push(p); return p.child; },
  };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut: (k: string, s: any) => shortcuts.set(k, s), registerTool: (t: any) => tools.set(t.name, t) } as any, home, { focusCheck: async () => 'focused', ...dependencies } as any);
  const speak = (text = 'Hola mundo.') => tools.get('speak').execute('id', { text }, undefined, undefined, ctx);
  return { home, events, shortcuts, tools, notifications, pythons, audios, ctx, speak, piperSpawns, close: () => rmSync(home, { recursive: true, force: true }) };
}
const outDirOf = (p: { writes: any[] }) => p.writes.find(w => w.type === 'synth').outDir as string;

test('Piper voices keep the exact current path and never touch the Qwen route', async () => {
  const h = harness({ voiceId: 'es_MX' });
  try {
    const run = h.speak();
    await until(() => h.audios.length === 1);
    assert.equal(h.pythons.length, 0);
    assert.deepEqual(h.audios[0].writes[0], { schema: AS, type: 'speak', id: 1, text: 'Hola mundo.', speed: 1.25, runtime: '/verified/runtime', model: { root: '/verified/model', name: 'es_MX-claude-high.onnx' } });
    h.audios[0].emit({ schema: AS, type: 'done', id: 1 });
    assert.equal((await run).isError, undefined);
  } finally { h.close(); }
});

test('a Qwen voice that is not installed notifies how to install and spawns nothing', async () => {
  for (const status of [{ manifest: 'missing', voices: { 'qwen-intima': 'missing' } }, { manifest: 'valid', voices: { 'qwen-intima': 'invalid' } }, { manifest: 'invalid', voices: { 'qwen-intima': 'installed' } }]) {
    const h = harness({ status });
    try {
      const result = await h.speak();
      assert.equal(result.isError, true);
      assert.equal(h.notifications.length, 1);
      assert.equal(h.notifications[0][1], 'error');
      assert.match(h.notifications[0][0], /Qwen voice "Íntima" is not installed.*mlx-audio.*README/);
      assert.equal(h.pythons.length + h.audios.length, 0);
    } finally { h.close(); }
  }
});

test('an installed Qwen voice spawns the manifest python lazily and sends synth with the exact ref and transcript', async () => {
  const h = harness();
  try {
    assert.equal(h.pythons.length, 0, 'nothing starts at registration');
    const run = h.speak('Hola mundo.');
    await until(() => h.pythons.length === 1);
    assert.equal(h.pythons[0].python, '/fake/python3');
    assert.equal(basename(h.pythons[0].script), 'speak-qwen-worker.py');
    assert.equal(h.pythons[0].writes.length, 0, 'waits for ready before synth');
    h.pythons[0].emit({ schema: QS, type: 'ready' });
    await until(() => h.pythons[0].writes.length === 1);
    const synth = h.pythons[0].writes[0];
    assert.deepEqual({ ...synth, outDir: undefined }, { schema: QS, type: 'synth', id: 1, text: 'Hola mundo.', ref: join(h.home, 'voices', 'qwen3', voice.file), refText: voice.transcript, outDir: undefined, speed: 1.25 });
    assert.equal(statSync(synth.outDir).mode & 0o777, 0o700);
    h.events.get('session_shutdown')!({}, h.ctx);
    assert.equal((await run).isError, true);
  } finally { h.close(); }
});

test('chunks are forwarded to the audio worker as play in seq order, and out-of-order chunks are rejected', async () => {
  const h = harness();
  try {
    const run = h.speak();
    await until(() => h.pythons.length === 1);
    const py = h.pythons[0];
    py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length === 1);
    const dir = outDirOf(py);
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav: join(dir, 'chunk-1-0.wav'), seconds: 1 });
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 1, wav: join(dir, 'chunk-1-1.wav'), seconds: 1 });
    await until(() => h.audios[0]?.writes.length === 2);
    assert.deepEqual(h.audios[0].writes, [
      { schema: AS, type: 'play', id: 1, wav: join(dir, 'chunk-1-0.wav'), speed: 1, runtime: '/verified/runtime' },
      { schema: AS, type: 'play', id: 2, wav: join(dir, 'chunk-1-1.wav'), speed: 1, runtime: '/verified/runtime' },
    ]);
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 5, wav: join(dir, 'chunk-1-5.wav'), seconds: 1 });
    const result = await run;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid Qwen worker response/);
    assert.equal(h.audios[0].writes.length, 2, 'the bad chunk is never played');
  } finally { h.close(); }
});

test('a chunk file is deleted once the audio worker reports done, and speech completes after the last chunk', async () => {
  const h = harness();
  try {
    const run = h.speak();
    await until(() => h.pythons.length === 1);
    const py = h.pythons[0];
    py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length === 1);
    const wav = join(outDirOf(py), 'chunk-1-0.wav'); writeFileSync(wav, 'RIFF');
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav, seconds: 1 });
    py.emit({ schema: QS, type: 'done', id: 1 });
    await until(() => h.audios[0]?.writes.length === 1);
    assert.equal(existsSync(wav), true, 'kept while it has not played');
    h.audios[0].emit({ schema: AS, type: 'done', id: 1 });
    const result = await run;
    assert.equal(result.isError, undefined);
    assert.equal(existsSync(wav), false);
    assert.equal(py.child.killed, 0, 'the synth worker stays warm for the next utterance');
    const again = h.speak('Otra vez.'); await until(() => py.writes.length === 2);
    assert.equal(h.pythons.length, 1, 'second utterance reuses the running worker');
    assert.equal(py.writes[1].id, 2);
    h.events.get('session_shutdown')!({}, h.ctx); await again;
  } finally { h.close(); }
});

test('stop kills the python worker and the audio worker, drops chunks, and the next speech respawns lazily', async () => {
  const h = harness();
  try {
    const run = h.speak();
    await until(() => h.pythons.length === 1);
    const py = h.pythons[0];
    py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length === 1);
    const wav = join(outDirOf(py), 'chunk-1-0.wav'); writeFileSync(wav, 'RIFF');
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav, seconds: 1 });
    await until(() => h.audios.length === 1);
    await h.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.stop).handler(h.ctx);
    assert.equal(py.child.killed, 1);
    assert.equal(h.audios[0].child.killed >= 1, true);
    assert.equal(existsSync(wav), false);
    assert.deepEqual([(await run).isError, (await run).content[0].text], [true, 'Speech cancelled.']);
    assert.deepEqual(h.notifications, []);
    const next = h.speak(); await until(() => h.pythons.length === 2);
    h.events.get('session_shutdown')!({}, h.ctx); await next;
  } finally { h.close(); }
});

test('shutdown kills both workers and removes the private temp dir', async () => {
  const h = harness();
  try {
    const run = h.speak();
    await until(() => h.pythons.length === 1);
    const py = h.pythons[0];
    py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length === 1);
    const dir = outDirOf(py);
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav: join(dir, 'chunk-1-0.wav'), seconds: 1 });
    await until(() => h.audios.length === 1);
    assert.equal(existsSync(dir), true);
    h.events.get('session_shutdown')!({}, h.ctx);
    assert.equal(py.child.killed, 1);
    assert.equal(h.audios[0].child.killed >= 1, true);
    assert.equal(existsSync(dir), false);
    await run;
  } finally { h.close(); }
});

test('Qwen speech keeps the interactive-parent guard: non-TUI and child sessions spawn nothing', async () => {
  const h = harness();
  try {
    for (const ctx of [{ ...h.ctx, mode: 'rpc' }, { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getHeader: () => ({ type: 'session', parentSession: '/p.jsonl' }) } }]) {
      const result = await h.tools.get('speak').execute('id', { text: 'Hola' }, undefined, undefined, ctx);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /interactive parent TUI/);
    }
    assert.equal(h.pythons.length + h.audios.length + h.notifications.length, 0);
  } finally { h.close(); }
});

// ---- timeouts and failure paths (fake clock; no real python) ----
const READY_MS = 180_000, IDLE_MS = 120_000;
const withClock = async (body: () => Promise<void>) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try { await body(); } finally { mock.timers.reset(); }
};
const ready = async (h: ReturnType<typeof harness>, n = 0) => { await until(() => h.pythons.length > n); const py = h.pythons[n]; py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length >= 1); return py; };
/** Runs one automatic utterance the way agent_settled does, so failures reach the user as notifications. */
const auto = (h: ReturnType<typeof harness>) => {
  writeFileSync(join(h.home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all', voice: 'qwen-intima', speed: 1.25 }));
  return h.events.get('agent_settled')!({ aborted: false }, h.ctx) as Promise<void>;
};
const errorNotes = (h: ReturnType<typeof harness>) => h.notifications.filter(n => n[1] === 'error');

test('playback time is never counted against synthesis: long playback after fast synthesis completes without a timeout', async () => {
  await withClock(async () => {
    const h = harness();
    try {
      const run = h.speak();
      const py = await ready(h);
      const dir = outDirOf(py);
      for (let i = 0; i < 3; i++) py.emit({ schema: QS, type: 'chunk', id: 1, seq: i, wav: join(dir, `chunk-1-${i}.wav`), seconds: 200 });
      py.emit({ schema: QS, type: 'done', id: 1 });
      await until(() => h.audios[0]?.writes.length === 3);
      mock.timers.tick(600_000); // 600 s of legitimate playback, far past the old 300 s utterance timeout
      assert.equal(py.child.killed, 0);
      for (const id of [1, 2, 3]) h.audios[0].emit({ schema: AS, type: 'done', id });
      const result = await run;
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, 'Speech completed.');
      assert.equal(py.child.killed, 0, 'the synth worker stays warm');
    } finally { h.close(); }
  });
});

const OK_TEXT = 'Speech completed.';
/** Every failure must leave no `play` traffic, no chunk files, and no stuck state: the next utterance respawns cleanly. */
async function assertRecovers(h: ReturnType<typeof harness>, pythonsBefore: number, audiosBefore: number) {
  const again = h.speak('Otra vez.');
  const py = await ready(h, pythonsBefore);
  assert.equal(h.pythons.length, pythonsBefore + 1, 'a fresh synth worker was spawned');
  assert.equal(py.writes[0].id, 2);
  const wav = join(outDirOf(py), 'chunk-2-0.wav'); writeFileSync(wav, 'RIFF');
  py.emit({ schema: QS, type: 'chunk', id: 2, seq: 0, wav, seconds: 1 });
  py.emit({ schema: QS, type: 'done', id: 2 });
  await until(() => h.audios.length === audiosBefore + 1 && h.audios[audiosBefore].writes.length === 1);
  h.audios[audiosBefore].emit({ schema: AS, type: 'done', id: h.audios[audiosBefore].writes[0].id });
  const result = await again;
  assert.deepEqual([result.isError, result.content[0].text], [undefined, OK_TEXT]);
  assert.equal(existsSync(wav), false);
}
/** Starts an utterance and drives it to "one chunk is playing", returning what the failure assertions need. */
async function playing(h: ReturnType<typeof harness>) {
  const run = auto(h);
  const py = await ready(h);
  const dir = outDirOf(py), wav = join(dir, 'chunk-1-0.wav'); writeFileSync(wav, 'RIFF');
  py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav, seconds: 1 });
  await until(() => h.audios[0]?.writes.length === 1);
  return { run, py, dir, wav, audio: h.audios[0] };
}
const lateTrafficIgnored = (h: ReturnType<typeof harness>, py: any, dir: string, plays: number) => {
  py.emit({ schema: QS, type: 'chunk', id: 1, seq: 1, wav: join(dir, 'chunk-1-1.wav'), seconds: 1 });
  py.emit({ schema: QS, type: 'done', id: 1 });
  assert.equal(h.audios.reduce((n, a) => n + a.writes.length, 0), plays, 'no further play writes after the failure');
};

test('failure: the python spawn fails -> error notification, no workers, no temp dir leaked, next utterance respawns', async () => {
  const h = harness({ spawnFailures: 1 });
  const leftovers = () => readdirSync(tmpdir()).filter(n => n.startsWith('gentle-speak-')).length;
  const before = leftovers();
  try {
    await auto(h);
    assert.deepEqual(h.notifications, [['Qwen worker could not start.', 'error']]);
    assert.equal(h.pythons.length + h.audios.length, 0, 'no child was created');
    assert.equal(leftovers(), before, 'the private temp dir was removed');
    h.notifications.length = 0;
    await assertRecovers(h, 0, 0);
    assert.deepEqual(h.notifications, []);
    h.events.get('session_shutdown')!({}, h.ctx);
  } finally { h.close(); }
});

test('failure: the worker emits error for the synth -> notified, python and audio killed, chunk removed, nothing more played, respawns', async () => {
  await withClock(async () => {
    const h = harness();
    try {
      const { run, py, dir, wav, audio } = await playing(h);
      py.emit({ schema: QS, type: 'error', id: 1, code: 'synth' });
      await run;
      assert.deepEqual(errorNotes(h), [['Qwen synthesis failed. Check that mlx-audio and the model are installed (see README, "Qwen voices").', 'error']]);
      assert.equal(py.child.killed, 1);
      assert.equal(audio.child.killed, 1);
      assert.equal(existsSync(wav), false);
      lateTrafficIgnored(h, py, dir, 1);
      await assertRecovers(h, 1, 1);
      assert.equal(existsSync(dir), false, 'the previous utterance directory is gone once the next one starts');
      h.events.get('session_shutdown')!({}, h.ctx);
    } finally { h.close(); }
  });
});

test('failure: the worker crashes mid-synthesis -> notified, exited python is not killed again, audio killed, chunk removed, respawns', async () => {
  const h = harness();
  try {
    const { run, py, dir, wav, audio } = await playing(h);
    py.child.emit('exit', 1, null);
    await run;
    assert.deepEqual(errorNotes(h), [['Qwen worker exited before speech finished.', 'error']]);
    assert.equal(py.child.killed, 0, 'an already-exited worker is not killed');
    assert.equal(audio.child.killed, 1);
    assert.equal(existsSync(wav), false);
    lateTrafficIgnored(h, py, dir, 1);
    await assertRecovers(h, 1, 1);
    assert.equal(existsSync(dir), false);
    h.events.get('session_shutdown')!({}, h.ctx);
  } finally { h.close(); }
});

test('failure: ready never arrives -> readiness timeout, python killed, no synth and no audio, respawns', async () => {
  await withClock(async () => {
    const h = harness();
    try {
      const run = auto(h);
      await until(() => h.pythons.length === 1);
      const py = h.pythons[0];
      mock.timers.tick(READY_MS - 1);
      assert.deepEqual(h.notifications, []);
      mock.timers.tick(1);
      await run;
      assert.deepEqual(errorNotes(h), [['Qwen worker did not become ready.', 'error']]);
      assert.equal(py.child.killed, 1);
      assert.equal(py.writes.length, 0, 'synth is never sent');
      assert.equal(h.audios.length, 0);
      py.emit({ schema: QS, type: 'ready' });
      assert.equal(py.writes.length, 0, 'a late ready from the dead worker does nothing');
      await assertRecovers(h, 1, 0);
      h.events.get('session_shutdown')!({}, h.ctx);
    } finally { h.close(); }
  });
});

test('failure: no chunk within the progress timeout -> timed out, killed, chunk removed; every chunk re-arms the timer', async () => {
  await withClock(async () => {
    const h = harness();
    try {
      const { run, py, dir, wav, audio } = await playing(h);
      mock.timers.tick(IDLE_MS - 1);
      py.emit({ schema: QS, type: 'chunk', id: 1, seq: 1, wav: join(dir, 'chunk-1-1.wav'), seconds: 1 });
      await until(() => audio.writes.length === 2);
      mock.timers.tick(IDLE_MS - 1);
      assert.deepEqual(h.notifications, [], 'a chunk reset the progress timer');
      mock.timers.tick(1);
      await run;
      assert.deepEqual(errorNotes(h), [['Qwen worker timed out.', 'error']]);
      assert.equal(py.child.killed, 1);
      assert.equal(audio.child.killed, 1);
      assert.equal(existsSync(wav), false);
      lateTrafficIgnored(h, py, dir, 2);
      await assertRecovers(h, 1, 1);
      h.events.get('session_shutdown')!({}, h.ctx);
    } finally { h.close(); }
  });
});

test('failure: the audio worker reports a playback error -> notified, both children killed, chunk removed, nothing more played, respawns', async () => {
  const h = harness();
  try {
    const { run, py, dir, wav, audio } = await playing(h);
    audio.emit({ schema: AS, type: 'error', id: 1, code: 'playback' });
    await run;
    assert.deepEqual(errorNotes(h), [['Audio playback failed.', 'error']]);
    assert.equal(py.child.killed, 1);
    assert.equal(audio.child.killed, 1);
    assert.equal(existsSync(wav), false);
    lateTrafficIgnored(h, py, dir, 1);
    await assertRecovers(h, 1, 1);
    assert.equal(h.audios.length, 2, 'the audio worker is respawned too');
    h.events.get('session_shutdown')!({}, h.ctx);
  } finally { h.close(); }
});

test('replay: late messages of the superseded request id are ignored; the new request speaks normally', async () => {
  const h = harness();
  try {
    const first = h.speak('Primero.');
    const py = await ready(h);
    const oldDir = outDirOf(py);
    const second = h.speak('Segundo.');
    await until(() => py.writes.filter(w => w.type === 'synth').length === 2); // the warm synth worker is reused
    assert.equal((await first).content[0].text, 'Speech cancelled.');
    assert.equal(py.child.killed, 0);
    const synth = py.writes.filter(w => w.type === 'synth')[1];
    assert.equal(synth.id, 2);
    // The old synthesis is still finishing in the same worker: its late traffic must not fail request 2.
    py.emit({ schema: QS, type: 'error', id: 1, message: 'output dir removed' });
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 5, wav: join(oldDir, 'chunk-1-5.wav'), seconds: 1 });
    py.emit({ schema: QS, type: 'done', id: 1 });
    assert.equal(h.audios.length, 0, 'no playback was started for the superseded request');
    const wav = join(synth.outDir, 'chunk-2-0.wav'); writeFileSync(wav, 'RIFF');
    py.emit({ schema: QS, type: 'chunk', id: 2, seq: 0, wav, seconds: 1 });
    py.emit({ schema: QS, type: 'done', id: 2 });
    await until(() => h.audios.length === 1 && h.audios[0].writes.length === 1);
    h.audios[0].emit({ schema: AS, type: 'done', id: h.audios[0].writes[0].id });
    const result = await second;
    assert.deepEqual([result.isError, result.content[0].text], [undefined, OK_TEXT]);
    assert.equal(py.child.killed, 0);
  } finally { h.close(); }
});

test('replay: a message with an id that was never issued still fails the request as invalid', async () => {
  for (const bad of [{ type: 'error', id: 7 }, { type: 'done', id: 7 }, { type: 'chunk', id: 7, seq: 0, wav: '/x/y.wav', seconds: 1 }]) {
    const h = harness();
    try {
      const first = h.speak('Primero.');
      const py = await ready(h);
      py.emit({ schema: QS, ...bad });
      const result = await first;
      assert.deepEqual([result.isError, result.content[0].text], [true, 'Invalid Qwen worker response.'], JSON.stringify(bad));
    } finally { h.close(); }
  }
});

test('the audio worker error cause reaches the user: `Audio playback failed: <cause>.`, bounded and without paths; no cause keeps the bare message', async () => {
  const cases: Array<[unknown, string]> = [
    ['Sample rate update timed out', 'Audio playback failed: Sample rate update timed out.'],
    ['x'.repeat(500), `Audio playback failed: ${'x'.repeat(120)}.`],
    ['bad /Users/me/file now', 'Audio playback failed: bad now.'],
    ['', 'Audio playback failed.'],
    [42, 'Audio playback failed.'],
    [undefined, 'Audio playback failed.'],
  ];
  for (const [cause, text] of cases) {
    const h = harness();
    try {
      const { run, audio } = await playing(h);
      audio.emit({ schema: AS, type: 'error', id: 1, code: 'playback', ...(cause === undefined ? {} : { cause }) });
      await run;
      assert.deepEqual(errorNotes(h), [[text, 'error']], String(cause).slice(0, 20));
    } finally { h.close(); }
  }
});

test('S9: a Qwen utterance holds the single-voice lock for its whole duration and releases it on done and on stop', async () => {
  const h = harness();
  try {
    const locked = () => existsSync(join(h.home, 'voice.lock'));
    const run = h.speak();
    await until(() => h.pythons.length === 1);
    assert.equal(locked(), true, 'held before synthesis starts');
    const py = h.pythons[0];
    py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length === 1);
    const wav = join(outDirOf(py), 'chunk-1-0.wav'); writeFileSync(wav, 'RIFF');
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav, seconds: 1 });
    py.emit({ schema: QS, type: 'done', id: 1 });
    await until(() => h.audios.length === 1 && h.audios[0].writes.length === 1);
    assert.equal(locked(), true, 'still held while playing');
    h.audios[0].emit({ schema: AS, type: 'done', id: h.audios[0].writes[0].id });
    assert.equal((await run).isError, undefined);
    await until(() => !locked());
    const again = h.speak();
    await until(() => h.pythons.length >= 1 && locked());
    await h.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.stop).handler(h.ctx);
    assert.equal((await again).content[0].text, 'Speech cancelled.');
    await until(() => !locked());
  } finally { h.events.get('session_shutdown')!({}, h.ctx); h.close(); }
});

test('streamed parts: every part plays in arrival order, and speech finishes only after worker done and the last play', async () => {
  const h = harness();
  try {
    const run = h.speak();
    await until(() => h.pythons.length === 1);
    const py = h.pythons[0];
    py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length === 1);
    const dir = outDirOf(py);
    const wavs = [0, 1, 2].map(i => join(dir, `chunk-1-${i}.wav`)); wavs.forEach(w => writeFileSync(w, 'RIFF'));
    let outcome: any; run.then(r => { outcome = r; });
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav: wavs[0], seconds: 2 });
    await until(() => h.audios[0]?.writes.length === 1);
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 1, wav: wavs[1], seconds: 2 });
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 2, wav: wavs[2], seconds: 2 });
    py.emit({ schema: QS, type: 'done', id: 1 });
    await until(() => h.audios[0].writes.length === 3);
    assert.deepEqual(h.audios[0].writes.map(w => w.wav), wavs, 'played in arrival order');
    h.audios[0].emit({ schema: AS, type: 'done', id: 1 }); h.audios[0].emit({ schema: AS, type: 'done', id: 2 });
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.equal(outcome, undefined, 'worker done alone does not finish while a chunk is still playing');
    assert.equal(existsSync(wavs[2]), true);
    h.audios[0].emit({ schema: AS, type: 'done', id: 3 });
    assert.equal((await run).isError, undefined);
    assert.deepEqual(wavs.map(existsSync), [false, false, false]);
  } finally { h.close(); }
});

test('streamed parts: a duplicate seq is rejected as invalid and the repeated part is never played', async () => {
  const h = harness();
  try {
    const run = h.speak();
    await until(() => h.pythons.length === 1);
    const py = h.pythons[0];
    py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length === 1);
    const dir = outDirOf(py);
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav: join(dir, 'chunk-1-0.wav'), seconds: 2 });
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav: join(dir, 'chunk-1-0.wav'), seconds: 2 });
    const result = await run;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid Qwen worker response/);
    assert.equal(h.audios[0].writes.length, 1);
  } finally { h.close(); }
});

test('streamed parts + replay: parts of the superseded id that arrive mid-stream are ignored; the new id plays its own parts', async () => {
  const h = harness();
  try {
    const first = h.speak('Primera.');
    await until(() => h.pythons.length === 1);
    const py = h.pythons[0];
    py.emit({ schema: QS, type: 'ready' }); await until(() => py.writes.length === 1);
    const dir = outDirOf(py);
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 0, wav: join(dir, 'chunk-1-0.wav'), seconds: 2 });
    await until(() => h.audios[0]?.writes.length === 1);
    const second = h.speak('Segunda.');
    assert.equal((await first).content[0].text, 'Speech cancelled.');
    await until(() => py.writes.length === 2);
    py.emit({ schema: QS, type: 'chunk', id: 1, seq: 1, wav: join(dir, 'chunk-1-1.wav'), seconds: 2 }); // late part of id 1
    py.emit({ schema: QS, type: 'done', id: 1 });
    py.emit({ schema: QS, type: 'chunk', id: 2, seq: 0, wav: join(outDirOf({ writes: [py.writes[1]] }), 'chunk-2-0.wav'), seconds: 2 });
    py.emit({ schema: QS, type: 'chunk', id: 2, seq: 1, wav: join(outDirOf({ writes: [py.writes[1]] }), 'chunk-2-1.wav'), seconds: 2 });
    py.emit({ schema: QS, type: 'done', id: 2 });
    await until(() => h.audios.at(-1)!.writes.length === 2);
    const audio = h.audios.at(-1)!;
    audio.emit({ schema: AS, type: 'done', id: 3 }); // play ids continue across utterances: parts of id 2 are play ids 2 and 3
    audio.emit({ schema: AS, type: 'done', id: 2 });
    assert.equal((await second).isError, undefined);
  } finally { h.close(); }
});

// ---- T30a: prepare (synthesize without playing) and speakPrepared, driven directly through createQwenSpeech ----
const tickMany = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
function direct() {
  const root = mkdtempSync(join(tmpdir(), 'speak-qwen-prep-'));
  const pythons: Array<ReturnType<typeof fakeChild>> = [], audios: Array<ReturnType<typeof fakeChild>> = [];
  const qwen = createQwenSpeech({ tmpRoot: root, spawnPython: () => { const p = fakeChild(); pythons.push(p); return p.child; }, spawnAudio: () => { const a = fakeChild(); audios.push(a); return a.child; } });
  const base = { python: '/fake/python3', ref: '/ref.wav', refText: 'ref', speed: 1.25 };
  const synths = () => pythons.flatMap(p => p.writes.filter(w => w.type === 'synth'));
  const chunk = (py: ReturnType<typeof fakeChild>, id: number, seq: number) => {
    const wav = join(synths().find(w => w.id === id).outDir, `chunk-${id}-${seq}.wav`); writeFileSync(wav, 'RIFF');
    py.emit({ schema: QS, type: 'chunk', id, seq, wav, seconds: 1 }); return wav;
  };
  const leftovers = () => readdirSync(root);
  return { root, pythons, audios, qwen, base, synths, chunk, leftovers, close: () => { qwen.dispose(); rmSync(root, { recursive: true, force: true }); } };
}
const readyOne = async (d: ReturnType<typeof direct>, count = 1) => { await until(() => d.pythons.length === 1); d.pythons[0].emit({ schema: QS, type: 'ready' }); await until(() => d.synths().length === count); };

test('prepare synthesizes WAV chunks in order without spawning the audio worker or playing', async () => {
  const d = direct();
  try {
    const result = d.qwen.prepare({ ...d.base, text: 'Hola. Adios.' });
    await readyOne(d);
    assert.deepEqual({ ...d.synths()[0], outDir: undefined }, { schema: QS, type: 'synth', id: 1, text: 'Hola. Adios.', ref: '/ref.wav', refText: 'ref', outDir: undefined, speed: 1.25 });
    const a = d.chunk(d.pythons[0], 1, 0), b = d.chunk(d.pythons[0], 1, 1);
    d.pythons[0].emit({ schema: QS, type: 'done', id: 1 });
    assert.deepEqual(await result, { ok: true, wavs: [a, b] });
    assert.equal(d.audios.length, 0, 'nothing plays');
    assert.equal(existsSync(a) && existsSync(b), true, 'the files wait for speakPrepared or discard');
    d.qwen.discard([a, b]);
    assert.equal(existsSync(a) || existsSync(b), false);
    assert.deepEqual(d.leftovers(), [], 'discarding every WAV removes the prepare directory');
  } finally { d.close(); }
});

test('prepare rejects an out-of-order chunk, deleting what it wrote and not reusing the worker', async () => {
  const d = direct();
  try {
    const bad = d.qwen.prepare({ ...d.base, text: 'Uno.' });
    await readyOne(d);
    const first = d.chunk(d.pythons[0], 1, 0);
    d.chunk(d.pythons[0], 1, 5);
    assert.deepEqual(await bad, { ok: false, message: 'Invalid Qwen worker response.' });
    assert.equal(existsSync(first), false);
    assert.equal(d.pythons[0].child.killed, 1);
    assert.deepEqual(d.leftovers(), []);
  } finally { d.close(); }
});

test('cancelling a prepare through its AbortSignal resolves cancelled and deletes its WAVs but keeps the worker warm', async () => {
  const d = direct();
  try {
    const controller = new AbortController();
    const result = d.qwen.prepare({ ...d.base, text: 'Uno.', signal: controller.signal });
    await readyOne(d);
    const wav = d.chunk(d.pythons[0], 1, 0);
    controller.abort();
    assert.deepEqual(await result, { ok: false, message: 'Speech cancelled.', cancelled: true });
    assert.equal(existsSync(wav), false);
    assert.deepEqual(d.leftovers(), []);
    assert.equal(d.pythons[0].child.killed, 0);
    const already = await d.qwen.prepare({ ...d.base, text: 'Dos.', signal: controller.signal });
    assert.equal(already.ok === false && already.cancelled, true, 'an already-aborted signal never starts');
    assert.equal(d.synths().length, 1);
  } finally { d.close(); }
});

test('speakPrepared plays the prepared WAVs in order, then synthesizes and plays the remainder', async () => {
  const d = direct();
  try {
    const prep = d.qwen.prepare({ ...d.base, text: 'Uno.' });
    await readyOne(d);
    const a = d.chunk(d.pythons[0], 1, 0), b = d.chunk(d.pythons[0], 1, 1);
    d.pythons[0].emit({ schema: QS, type: 'done', id: 1 });
    assert.equal((await prep).ok, true);
    const run = d.qwen.speakPrepared({ ...d.base, wavs: [a, b], remainderText: ' Dos tres. ', runtime: '/rt' });
    await until(() => d.audios[0]?.writes.length === 2 && d.synths().length === 2);
    assert.deepEqual(d.audios[0].writes, [
      { schema: AS, type: 'play', id: 1, wav: a, speed: 1, runtime: '/rt' },
      { schema: AS, type: 'play', id: 2, wav: b, speed: 1, runtime: '/rt' },
    ]);
    assert.deepEqual([d.synths()[1].id, d.synths()[1].text], [2, 'Dos tres.']);
    assert.equal(d.pythons.length, 1, 'the same warm worker');
    const c = d.chunk(d.pythons[0], 2, 0);
    await until(() => d.audios[0].writes.length === 3);
    assert.equal(d.audios[0].writes[2].wav, c);
    d.pythons[0].emit({ schema: QS, type: 'done', id: 2 });
    for (const id of [1, 2, 3]) d.audios[0].emit({ schema: AS, type: 'done', id });
    assert.deepEqual(await run, { ok: true });
    assert.equal([a, b, c].some(existsSync), false, 'every WAV is deleted once played');
    assert.deepEqual(d.leftovers().filter(name => name.startsWith('gentle-speak-prep-')), [], 'the prepare directory is gone');
  } finally { d.close(); }
});

test('speakPrepared with an empty remainder plays the WAVs and synthesizes nothing', async () => {
  const d = direct();
  try {
    const prep = d.qwen.prepare({ ...d.base, text: 'Uno.' });
    await readyOne(d);
    const a = d.chunk(d.pythons[0], 1, 0);
    d.pythons[0].emit({ schema: QS, type: 'done', id: 1 }); await prep;
    const run = d.qwen.speakPrepared({ ...d.base, wavs: [a], remainderText: '', runtime: '/rt' });
    await until(() => d.audios[0]?.writes.length === 1);
    d.audios[0].emit({ schema: AS, type: 'done', id: 1 });
    assert.deepEqual(await run, { ok: true });
    assert.equal(d.synths().length, 1);
    assert.equal(existsSync(a), false);
  } finally { d.close(); }
});

test('a failing audio worker fails speakPrepared with the same outcome shape as speak and deletes the WAVs', async () => {
  const d = direct();
  try {
    const prep = d.qwen.prepare({ ...d.base, text: 'Uno.' });
    await readyOne(d);
    const a = d.chunk(d.pythons[0], 1, 0);
    d.pythons[0].emit({ schema: QS, type: 'done', id: 1 }); await prep;
    const run = d.qwen.speakPrepared({ ...d.base, wavs: [a], remainderText: '', runtime: '/rt' });
    await until(() => d.audios[0]?.writes.length === 1);
    d.audios[0].emit({ schema: AS, type: 'error', id: 1, cause: 'device gone' });
    assert.deepEqual(await run, { ok: false, message: 'Audio playback failed: device gone.' });
    assert.equal(existsSync(a), false);
  } finally { d.close(); }
});

test('a prepare requested while a speak runs waits for it: the worker is never given two requests at once', async () => {
  const d = direct();
  try {
    const speaking = d.qwen.speak({ ...d.base, text: 'Habla.', runtime: '/rt' });
    await until(() => d.pythons.length === 1);
    const prep = d.qwen.prepare({ ...d.base, text: 'Luego.' });
    d.pythons[0].emit({ schema: QS, type: 'ready' }); await until(() => d.synths().length === 1);
    await tickMany();
    assert.deepEqual(d.synths().map(w => w.text), ['Habla.'], 'prepare has not reached the worker');
    d.pythons[0].emit({ schema: QS, type: 'done', id: 1 });
    assert.deepEqual(await speaking, { ok: true });
    await until(() => d.synths().length === 2);
    assert.deepEqual(d.synths().map(w => [w.id, w.text]), [[1, 'Habla.'], [2, 'Luego.']]);
    d.pythons[0].emit({ schema: QS, type: 'done', id: 2 });
    assert.deepEqual(await prep, { ok: true, wavs: [] });
  } finally { d.close(); }
});

test('a speak that arrives while a prepare runs cancels the prepare (its WAVs are deleted) and takes the worker', async () => {
  const d = direct();
  try {
    const prep = d.qwen.prepare({ ...d.base, text: 'Especula.' });
    await readyOne(d);
    const wav = d.chunk(d.pythons[0], 1, 0);
    const speaking = d.qwen.speak({ ...d.base, text: 'Real.', runtime: '/rt' });
    assert.deepEqual(await prep, { ok: false, message: 'Speech cancelled.', cancelled: true });
    assert.equal(existsSync(wav), false);
    await until(() => d.synths().length === 2);
    assert.deepEqual([d.synths()[1].id, d.synths()[1].text], [2, 'Real.']);
    d.pythons[0].emit({ schema: QS, type: 'chunk', id: 1, seq: 1, wav: join(d.root, 'late.wav'), seconds: 1 }); // late traffic of the cancelled prepare is ignored
    d.pythons[0].emit({ schema: QS, type: 'done', id: 1 });
    d.pythons[0].emit({ schema: QS, type: 'done', id: 2 });
    assert.deepEqual(await speaking, { ok: true });
  } finally { d.close(); }
});

test('stop cancels a running prepare and deletes finished prepared WAVs; a plain speak does not touch them', async () => {
  const d = direct();
  try {
    const first = d.qwen.prepare({ ...d.base, text: 'Uno.' });
    await readyOne(d);
    const kept = d.chunk(d.pythons[0], 1, 0);
    d.pythons[0].emit({ schema: QS, type: 'done', id: 1 }); await first;
    const other = d.qwen.speak({ ...d.base, text: 'Otro.', runtime: '/rt' });
    await until(() => d.synths().length === 2);
    assert.equal(existsSync(kept), true, 'a speak keeps buffered speculative audio');
    d.pythons[0].emit({ schema: QS, type: 'done', id: 2 }); await other;
    const second = d.qwen.prepare({ ...d.base, text: 'Dos.' });
    await until(() => d.synths().length === 3);
    const wav = d.chunk(d.pythons[0], 3, 0);
    d.qwen.stop();
    assert.deepEqual(await second, { ok: false, message: 'Speech cancelled.', cancelled: true });
    assert.equal(existsSync(kept) || existsSync(wav), false);
    assert.deepEqual(d.leftovers(), []);
  } finally { d.close(); }
});

test('preserve: speak alone still uses its own directory, plays chunks in order, and removes its temp dir on stop', async () => {
  const d = direct();
  try {
    const run = d.qwen.speak({ ...d.base, text: 'Solo.', runtime: '/rt' });
    await readyOne(d);
    assert.match(basename(d.synths()[0].outDir), /^gentle-speak-\w/);
    const wav = d.chunk(d.pythons[0], 1, 0);
    await until(() => d.audios[0]?.writes.length === 1);
    assert.equal(d.audios[0].writes[0].wav, wav);
    d.qwen.stop();
    assert.deepEqual(await run, { ok: false, message: 'Speech cancelled.', cancelled: true });
    assert.deepEqual(d.leftovers(), []);
  } finally { d.close(); }
});
