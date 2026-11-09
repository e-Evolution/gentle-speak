import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import { QWEN_VOICES } from '../lib/speak-voices.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';

const QS = 'gentle.speak.qwen/v1', AS = 'gentle.speak/v1';
const voice = QWEN_VOICES['qwen-intima'];
const message = { role: 'assistant', stopReason: 'end_turn', content: [{ type: 'text', text: 'Resultado listo.' }] };
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setImmediate(r)); assert.ok(predicate(), 'condition not reached'); };
function fakeChild() {
  const writes: any[] = [];
  const child: any = Object.assign(new EventEmitter(), { stdin: { write: (line: string) => { writes.push(JSON.parse(line)); return true; } }, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0, kill() { child.killed++; return true; } });
  return { child, writes, emit: (m: object) => child.stdout.emit('data', JSON.stringify(m) + '\n') };
}
function harness(opts: { status?: any; voiceId?: string; manifest?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'speak-qwen-ext-'));
  const events = new Map<string, Function>(), shortcuts = new Map<string, any>(), tools = new Map<string, any>();
  const notifications: Array<[string, string]> = [];
  const pythons: Array<ReturnType<typeof fakeChild> & { python: string; script: string }> = [];
  const audios: Array<ReturnType<typeof fakeChild>> = [];
  const piperSpawns: string[] = [];
  mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true });
  if (opts.manifest !== false) writeFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ python: '/fake/python3' }));
  writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, voice: opts.voiceId ?? 'qwen-intima', speed: 1.25 }));
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [{ type: 'message', message }] }, ui: { notify: (text: string, level: string) => notifications.push([text, level]) } };
  const dependencies = {
    modelStatus: async () => ({ state: 'installed', path: '/verified/model' }),
    runtimeStatus: async () => ({ state: 'installed', path: '/verified/runtime' }),
    qwenStatus: async () => opts.status ?? { manifest: 'valid', voices: { 'qwen-intima': 'installed' } },
    spawn: () => { const a = fakeChild(); if (opts.voiceId && opts.voiceId.startsWith('es_')) piperSpawns.push('piper'); audios.push(a); return a.child; },
    spawnQwen: (python: string, script: string) => { const p = Object.assign(fakeChild(), { python, script }); pythons.push(p); return p.child; },
  };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut: (k: string, s: any) => shortcuts.set(k, s), registerTool: (t: any) => tools.set(t.name, t) } as any, home, dependencies as any);
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
