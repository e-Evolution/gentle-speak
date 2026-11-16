/**
 * Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com
 * SPDX-License-Identifier: MIT
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the MIT License. See the LICENSE file in the root of
 * this project for the full license text.
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * MIT License for more details.
 * Email: victor.perez@e-evolution.com, http://www.e-evolution.com , http://github.com/e-Evolution
 * Created by victor.perez@e-evolution.com , www.e-evolution.com
 */
import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, readSpeakSettings } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';
import { writeEntry } from './helpers/custom-voice-fixture.ts';

// S11 wiring: the Mac voice as an extra voice and as fallback. All fakes: no `say`, no audio, no model. Scratch lives under mktemp.
const until = async (cond: () => boolean, what = 'condition') => {
  const deadline = Date.now() + 5000;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 1)); }
};
const quiet = (ms = 30) => new Promise(r => setTimeout(r, ms));
const AS = 'gentle.speak/v1';
const VOICES = [{ name: 'Paulina', locale: 'es_MX' }, { name: 'Mónica', locale: 'es_ES' }, { name: 'Eddy (Español (México))', locale: 'es_MX' }];
const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

interface Opts { voice?: string; patch?: Record<string, unknown>; say?: boolean; piper?: 'installed' | 'missing'; runtime?: 'installed' | 'missing'; qwen?: 'installed' | 'missing'; piperSpawnThrows?: boolean; qwenSpawnThrows?: boolean; focus?: () => string; mode?: string; header?: unknown; text?: string; voices?: typeof VOICES; listMac?: () => Promise<typeof VOICES>; voiceProbeMs?: number; platform?: string }
function setup(o: Opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'speak-mac-')); roots.push(home);
  mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true });
  writeFileSync(join(home, 'python.json'), JSON.stringify({ schema: 'gentle-speak.python/v1', python: '/fake/python3' }));
  // T45: Qwen voices are the user's own: `custom:intima` exists unless the test says `qwen: 'missing'`.
  if (o.qwen !== 'missing') writeEntry(join(home, 'voices', 'custom'), 'intima', { meta: { label: 'Íntima' } });
  const save = (patch: Record<string, unknown>) => writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all', voice: o.voice ?? 'mac', ...o.patch, ...patch }));
  save({});
  const events = new Map<string, Function>(), shortcuts = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const notes: Array<[string, string]> = [], statuses: Array<string | undefined> = [], selections: string[] = [], offered: string[][] = [];
  const sayCalls: Array<{ voice: string; text: string; speed: number; signal: AbortSignal; lockHeld: boolean }> = [];
  const sayResolvers: Array<(r: any) => void> = [];
  let sayMode: 'hold' | 'ok' | 'fail' = 'hold';
  const audioChildren: any[] = [], pythons: any[] = [];
  const fakeChild = () => { const c: any = Object.assign(new EventEmitter(), { writes: [] as any[], stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0, kill() { this.killed++; return true; } }); c.stdin = { write: (l: string) => { c.writes.push(JSON.parse(l)); return true; } }; return c; };
  const state = { focus: 'focused', branch: [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: o.text ?? 'Resultado listo.' }] } }] as any[] };
  let selection: any;
  const ctx: any = { cwd: '/work/gentle-theme', mode: o.mode ?? 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => o.header ?? { type: 'session' }, getBranch: () => state.branch },
    ui: { setStatus: (_k: string, t?: string) => statuses.push(t), notify: (t: string, l: string) => notes.push([t, l]), confirm: async () => false, select: async (_t: string, opts: string[]) => { offered.push(opts); return selections.shift(); }, input: async () => undefined, setWidget: (_k: string, f: any) => { if (typeof f === 'function') f({ getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => [] }, {}); } } };
  const deps: any = {
    ...hermetic(home),
    // T62: the host platform is injected (default macOS) so these Mac-voice tests mean the same on every CI host.
    platform: o.platform ?? 'darwin', sayAvailable: () => o.say !== false, listMacVoices: o.listMac ?? (async () => o.voices ?? VOICES), ...(o.voiceProbeMs ? { voiceProbeMs: o.voiceProbeMs } : {}),
    say: (req: any) => new Promise(resolve => {
      sayCalls.push({ ...req, lockHeld: existsSync(join(home, 'voice.lock')) });
      if (sayMode === 'ok') resolve({ ok: true, message: 'Speech completed.' });
      else if (sayMode === 'fail') resolve({ ok: false, message: 'Mac voice failed.' });
      else { sayResolvers.push(resolve); req.signal.addEventListener('abort', () => resolve({ ok: false, message: 'Speech cancelled.', cancelled: true }), { once: true }); }
    }),
    modelStatus: async () => ({ state: o.piper === 'missing' ? 'missing' : 'installed', path: '/m' }),
    runtimeStatus: async () => ({ state: o.runtime === 'missing' ? 'missing' : 'installed', path: '/r' }),
    spawn: () => { if (o.piperSpawnThrows) throw new Error('no worker'); const c = fakeChild(); audioChildren.push(c); return c; },
    spawnQwen: () => { if (o.qwenSpawnThrows) throw new Error('spawn failed'); const c = fakeChild(); pythons.push(c); return c; },
    focusCheck: async () => (o.focus ? o.focus() : state.focus), focusPollMs: 5, lockPollMs: 5, qwenTmpRoot: join(home, 'scratch'),
    resolveTerminal: async () => 'com.term', createWatcher: (opts: any) => { selection = opts; return { start() {}, stop() {} }; },
  };
  mkdirSync(join(home, 'scratch'));
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut: (k: string, s: any) => shortcuts.set(k, s), registerTool: (t: any) => tools.set(t.name, t) } as any, home, deps);
  return { home, events, shortcuts, tools, commands, notes, statuses, selections, offered, ctx, state, sayCalls, sayResolvers, audioChildren, pythons, save,
    setSay: (m: 'hold' | 'ok' | 'fail') => { sayMode = m; },
    tool: (text = 'Hola mundo.', signal?: AbortSignal) => tools.get('speak').execute('id', { text }, signal, undefined, ctx),
    settle: () => events.get('agent_settled')!({ aborted: false }, ctx),
    shutdown: () => events.get('session_shutdown')!({}, ctx),
    copy: () => selection, finishSay: (i = 0) => sayResolvers[i]({ ok: true, message: 'Speech completed.' }) };
}
const fallbackNotes = (s: { notes: Array<[string, string]> }) => s.notes.filter(([t]) => /speaking with the Mac voice/.test(t));

// ---- mac selected: every speech path uses say, under the lock ----
test('tool: with mac selected, say gets the text, picked voice and speed, under the voice lock, and no Piper/Qwen runtime is needed', async () => {
  const s = setup({ runtime: 'missing', piper: 'missing', qwen: 'missing', patch: { speed: 1.25 } });
  const run = s.tool('Hola mundo.');
  await until(() => s.sayCalls.length === 1, 'say');
  assert.deepEqual({ voice: s.sayCalls[0].voice, text: s.sayCalls[0].text, speed: s.sayCalls[0].speed, lockHeld: s.sayCalls[0].lockHeld }, { voice: 'Paulina', text: 'Hola mundo.', speed: 1.25, lockHeld: true });
  assert.equal(existsSync(join(s.home, 'voice.lock')), true, 'lock held during playback');
  s.finishSay();
  const out = await run;
  assert.equal(out.isError, undefined);
  assert.equal(out.content[0].text, 'Speech completed.');
  assert.equal(existsSync(join(s.home, 'voice.lock')), false, 'lock released after');
  assert.equal(s.audioChildren.length + s.pythons.length, 0);
  assert.deepEqual(s.notes, []);
});

test('macVoice setting wins when installed; an uninstalled one falls to auto', async () => {
  let s = setup({ patch: { macVoice: 'Eddy (Español (México))' } });
  void s.tool(); await until(() => s.sayCalls.length === 1);
  assert.equal(s.sayCalls[0].voice, 'Eddy (Español (México))');
  s.shutdown();
  s = setup({ patch: { macVoice: 'Ghost' } });
  void s.tool(); await until(() => s.sayCalls.length === 1);
  assert.equal(s.sayCalls[0].voice, 'Paulina');
  s.shutdown();
});

test('automatic speech at settle uses say', async () => {
  const s = setup({ text: 'Todo salió bien.' });
  const p = s.settle(); await until(() => s.sayCalls.length === 1, 'say');
  assert.equal(s.sayCalls[0].text, 'Todo salió bien.');
  assert.equal(s.sayCalls[0].lockHeld, true);
  s.finishSay(); await p; s.shutdown();
});

test('speak-last shortcut uses say', async () => {
  const s = setup({ text: 'Lee esto.' });
  const p = s.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.speakLast).handler(s.ctx);
  await until(() => s.sayCalls.length === 1, 'say');
  assert.equal(s.sayCalls[0].text, 'Lee esto.');
  s.finishSay(); await p; s.shutdown();
});

test('copy speech uses say', async () => {
  const s = setup({ patch: { copySpeech: true } });
  await s.events.get('session_start')!({}, s.ctx);
  await until(() => !!s.copy(), 'watcher');
  const p = s.copy().speak('Texto copiado');
  await until(() => s.sayCalls.length === 1, 'say');
  assert.equal(s.sayCalls[0].text, 'Texto copiado');
  s.finishSay(); await p; s.shutdown();
});

test('S9 deferral applies: an unfocused pane waits, then speaks once; unknown focus prefixes the project', async () => {
  let s = setup(); s.state.focus = 'unfocused';
  await s.settle(); await quiet();
  assert.equal(s.sayCalls.length, 0);
  s.state.focus = 'focused';
  await until(() => s.sayCalls.length === 1, 'say after focus');
  assert.equal(s.sayCalls[0].text, 'Resultado listo.');
  s.shutdown();
  s = setup({ focus: () => 'unknown' });
  void s.settle(); await until(() => s.sayCalls.length === 1, 'say');
  assert.equal(s.sayCalls[0].text, 'gentle-theme: Resultado listo.');
  s.shutdown();
});

test('stop key aborts the say signal and releases the lock; the tool result is cancelled', async () => {
  const s = setup();
  const run = s.tool(); await until(() => s.sayCalls.length === 1);
  await s.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.stop).handler(s.ctx);
  assert.equal(s.sayCalls[0].signal.aborted, true);
  const out = await run;
  assert.equal(out.isError, true); assert.equal(out.content[0].text, 'Speech cancelled.');
  assert.equal(existsSync(join(s.home, 'voice.lock')), false);
  assert.deepEqual(fallbackNotes(s), []);
  s.shutdown();
});

test('shutdown aborts say and drops it', async () => {
  const s = setup();
  const run = s.tool(); await until(() => s.sayCalls.length === 1);
  s.shutdown();
  assert.equal((await run).content[0].text, 'Speech cancelled.');
  assert.equal(s.sayCalls[0].signal.aborted, true);
});

test('toggle off drops a pending unfocused result', async () => {
  const s = setup(); s.state.focus = 'unfocused';
  await s.settle();
  await s.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.toggle).handler(s.ctx);
  s.state.focus = 'focused'; await quiet();
  assert.equal(s.sayCalls.length, 0);
  s.shutdown();
});

test('two sessions never overlap: the second waits for the first to release the lock', async () => {
  const s = setup();
  const first = s.tool('Uno.'); await until(() => s.sayCalls.length === 1);
  // A second extension instance on the same home (another session) must wait for the lock.
  const t = sharedHome(s);
  const second = t.tool('Dos.');
  await quiet(60);
  assert.equal(t.sayCalls.length, 0, 'second waits while the first holds the lock');
  s.finishSay(); await first;
  await until(() => t.sayCalls.length === 1, 'second say');
  t.finishSay(); await second; s.shutdown(); t.shutdown();
});
function sharedHome(first: ReturnType<typeof setup>) {
  const events = new Map<string, Function>(), tools = new Map<string, any>();
  const sayCalls: any[] = [], resolvers: Array<(r: any) => void> = [];
  const ctx: any = { cwd: '/w', mode: 'tui', hasUI: true, isIdle: () => true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [] }, ui: { setStatus() {}, notify() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false, setWidget() {} } };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool: (t: any) => tools.set(t.name, t) } as any, first.home, {
    ...hermetic(first.home), sayAvailable: () => true, listMacVoices: async () => VOICES, say: (r: any) => new Promise(res => { sayCalls.push(r); resolvers.push(res); }), focusCheck: async () => 'focused', focusPollMs: 5, lockPollMs: 5,
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }) } as any);
  return { sayCalls, tool: (text: string) => tools.get('speak').execute('id', { text }, undefined, undefined, ctx), finishSay: () => resolvers[0]({ ok: true, message: 'ok' }), shutdown: () => events.get('session_shutdown')!({}, ctx) };
}

test('mac selected but unavailable: today-style error, nothing speaks', async () => {
  const s = setup({ say: false });
  const out = await s.tool();
  assert.equal(out.isError, true); assert.match(out.content[0].text, /Mac voice is not available/);
  assert.equal(s.sayCalls.length, 0);
  const none = setup({ voices: [] });
  assert.match((await none.tool()).content[0].text, /Mac voice is not available/);
  assert.equal(none.sayCalls.length, 0);
});

test('mac: a say failure is reported as an error with no retry; invalid text and the parent guard never reach say', async () => {
  const s = setup(); s.setSay('fail');
  const out = await s.tool();
  assert.equal(out.isError, true); assert.equal(out.content[0].text, 'Mac voice failed.');
  assert.equal(s.sayCalls.length, 1);
  assert.equal((await s.tool('   ')).content[0].text, 'Invalid speech text.');
  assert.equal((await s.tool('a\u0007b')).content[0].text, 'Invalid speech text.');
  assert.equal(s.sayCalls.length, 1);
  const child = setup({ header: { type: 'session', parentSession: 'x' } });
  assert.equal((await child.tool()).content[0].text, 'Speech requires an interactive parent TUI session.');
  const rpc = setup({ mode: 'rpc' });
  assert.equal((await rpc.tool()).content[0].text, 'Speech requires an interactive parent TUI session.');
  assert.equal(child.sayCalls.length + rpc.sayCalls.length, 0);
});

test('mac never speculates: streaming updates start no Qwen worker', async () => {
  const s = setup();
  await s.events.get('message_update')!({ message: { role: 'assistant', content: [{ type: 'text', text: 'Primera frase completa. Segunda frase aquí.' }] } }, s.ctx);
  await quiet();
  assert.equal(s.pythons.length, 0);
});

// ---- fallback ----
test('fallback triggers: Piper model not installed, Piper runtime not installed, Piper worker cannot start', async () => {
  for (const o of [{ piper: 'missing' as const }, { runtime: 'missing' as const }, { piperSpawnThrows: true }]) {
    const s = setup({ voice: 'es_MX', ...o });
    const run = s.tool('Hola.');
    await until(() => s.sayCalls.length === 1, `say fallback ${JSON.stringify(o)}`);
    assert.equal(s.sayCalls[0].text, 'Hola.');
    assert.equal(s.sayCalls[0].voice, 'Paulina');
    assert.equal(s.sayCalls[0].lockHeld, true);
    s.finishSay();
    assert.equal((await run).isError, undefined);
    assert.equal(fallbackNotes(s).length, 1);
    s.shutdown();
  }
});

test('fallback trigger: Piper worker error and early exit during synthesis speak the same text with Mac', async () => {
  for (const fail of ['error', 'exit']) {
    const s = setup({ voice: 'es_MX' });
    const run = s.tool('Hola.');
    await until(() => s.audioChildren.length === 1, 'piper');
    if (fail === 'error') s.audioChildren[0].stdout.emit('data', JSON.stringify({ schema: AS, type: 'error', id: 1, cause: 'ENGINE' }) + '\n'); else s.audioChildren[0].emit('exit', 1);
    await until(() => s.sayCalls.length === 1, 'say fallback');
    assert.equal(s.sayCalls[0].text, 'Hola.');
    s.finishSay(); await run;
    assert.match(fallbackNotes(s)[0][0], /^gentle-speak: Español \(México\) unavailable \(.+\); speaking with the Mac voice\.$/);
    s.shutdown();
  }
});

test('fallback triggers for Qwen: not installed, runtime missing, worker spawn failure', async () => {
  for (const o of [{ qwen: 'missing' as const }, { runtime: 'missing' as const }, { qwenSpawnThrows: true }]) {
    const s = setup({ voice: 'custom:intima', ...o });
    const run = s.tool('Hola.');
    await until(() => s.sayCalls.length === 1, `say fallback ${JSON.stringify(o)}`);
    assert.equal(s.sayCalls[0].text, 'Hola.');
    s.finishSay(); await run;
    assert.equal(fallbackNotes(s).length, 1);
    assert.match(fallbackNotes(s)[0][0], /^gentle-speak: (Propia · Íntima|custom:intima) unavailable \(.+\); speaking with the Mac voice\.$/);
    assert.equal(s.notes.some(([t, l]) => l === 'error'), false, 'the not-installed error is replaced by the fallback notice');
    s.shutdown();
  }
});

test('fallback trigger for Qwen: a worker error reply during synthesis', async () => {
  const s = setup({ voice: 'custom:intima' });
  const run = s.tool('Hola.');
  await until(() => s.pythons.length === 1, 'qwen worker');
  s.pythons[0].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak.qwen/v1', type: 'error', id: 1, message: 'boom' }) + '\n');
  s.pythons[0].emit('exit', 1);
  await until(() => s.sayCalls.length === 1, 'say fallback');
  s.finishSay(); await run;
  assert.equal(fallbackNotes(s).length, 1);
  s.shutdown();
});

test('the fallback notice is shown once per session even across several fallbacks', async () => {
  const s = setup({ voice: 'es_MX', piper: 'missing' }); s.setSay('ok');
  for (let i = 0; i < 3; i++) assert.equal((await s.tool(`Texto ${i}.`)).isError, undefined);
  assert.equal(s.sayCalls.length, 3);
  assert.equal(fallbackNotes(s).length, 1);
  s.shutdown();
});

test('no fallback on cancel, stop, invalid text or the parent-session refusal', async () => {
  // cancel via the caller signal while Piper is playing
  let s = setup({ voice: 'es_MX' });
  const controller = new AbortController();
  const run = s.tool('Hola.', controller.signal);
  await until(() => s.audioChildren.length === 1);
  controller.abort();
  assert.equal((await run).content[0].text, 'Speech cancelled.');
  // stop key while Piper is playing
  const run2 = s.tool('Hola otra vez.');
  await until(() => s.audioChildren.length === 2);
  await s.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.stop).handler(s.ctx);
  assert.equal((await run2).content[0].text, 'Speech cancelled.');
  // invalid text
  assert.equal((await s.tool('  ')).content[0].text, 'Invalid speech text.');
  assert.equal(s.sayCalls.length, 0); assert.deepEqual(fallbackNotes(s), []);
  s.shutdown();
  // parent refusal, Piper not installed on purpose so a fallback would be tempting
  for (const o of [{ header: { type: 'session', parentSession: 'p' } }, { mode: 'rpc' }]) {
    const t = setup({ voice: 'es_MX', piper: 'missing', ...o });
    assert.equal((await t.tool()).content[0].text, 'Speech requires an interactive parent TUI session.');
    assert.equal(t.sayCalls.length, 0); assert.deepEqual(fallbackNotes(t), []);
  }
});

test('no fallback on cancel while Qwen is playing', async () => {
  const s = setup({ voice: 'custom:intima' });
  const controller = new AbortController();
  const run = s.tool('Hola.', controller.signal);
  await until(() => s.pythons.length === 1);
  controller.abort();
  assert.equal((await run).content[0].text, 'Speech cancelled.');
  await quiet();
  assert.equal(s.sayCalls.length, 0); assert.deepEqual(fallbackNotes(s), []);
  s.shutdown();
});

test('macFallback off keeps today\'s Piper and Qwen errors and never calls say', async () => {
  const piper = setup({ voice: 'es_MX', piper: 'missing', patch: { macFallback: false } });
  const out = await piper.tool();
  assert.equal(out.isError, true); assert.equal(out.content[0].text, 'Install and verify the voice and runtime with /speak first.');
  const qwen = setup({ voice: 'custom:intima', qwen: 'missing', patch: { macFallback: false } });
  const q = await qwen.tool();
  assert.match(q.content[0].text, /^Custom voice "intima" is not installed or is invalid\./);
  assert.equal(qwen.notes.some(([t, l]) => l === 'error' && /not installed/.test(t)), true);
  assert.equal(piper.sayCalls.length + qwen.sayCalls.length, 0);
  assert.deepEqual([...fallbackNotes(piper), ...fallbackNotes(qwen)], []);
});

test('Mac unavailable (no say, or no Spanish voice) keeps today\'s errors with no fallback notice', async () => {
  for (const o of [{ say: false }, { voices: [] }]) {
    const piper = setup({ voice: 'es_MX', piper: 'missing', ...o });
    const out = await piper.tool();
    assert.equal(out.content[0].text, 'Install and verify the voice and runtime with /speak first.');
    const qwen = setup({ voice: 'custom:intima', qwen: 'missing', ...o });
    assert.match((await qwen.tool()).content[0].text, /^Custom voice "intima" is not installed/);
    assert.equal(piper.sayCalls.length + qwen.sayCalls.length, 0);
    assert.deepEqual([...fallbackNotes(piper), ...fallbackNotes(qwen)], []);
  }
});

test('automatic speech that falls back reports no error, and with Mac unavailable reports today\'s error', async () => {
  const s = setup({ voice: 'es_MX', piper: 'missing' }); s.setSay('ok');
  await s.settle();
  assert.equal(s.sayCalls.length, 1);
  assert.equal(s.notes.some(([, l]) => l === 'error'), false);
  const u = setup({ voice: 'es_MX', piper: 'missing', say: false });
  await u.settle();
  assert.deepEqual(u.notes, [['Install and verify the voice and runtime with /speak first.', 'error']]);
});

// ---- PRESERVE: Piper and Qwen paths still work with the Mac voice available ----
test('PRESERVE: Piper speaks through its worker with the exact request and never calls say', async () => {
  const s = setup({ voice: 'es_MX', patch: { speed: 1.25 } });
  const run = s.tool('Hola mundo.');
  await until(() => s.audioChildren.length === 1);
  assert.deepEqual(s.audioChildren[0].writes[0], { schema: AS, type: 'speak', id: 1, text: 'Hola mundo.', speed: 1.25, runtime: '/r', model: { root: '/m', name: 'es_MX-claude-high.onnx' } });
  s.audioChildren[0].stdout.emit('data', JSON.stringify({ schema: AS, type: 'done', id: 1 }) + '\n');
  assert.equal((await run).isError, undefined);
  assert.equal(s.sayCalls.length, 0); assert.deepEqual(s.notes, []);
});

test('PRESERVE: Qwen speaks through its synth worker and never calls say', async () => {
  const s = setup({ voice: 'custom:intima' });
  const run = s.tool('Hola mundo.');
  await until(() => s.pythons.length === 1);
  assert.equal(s.sayCalls.length, 0);
  controllerStop(s);
  await run;
});
function controllerStop(s: ReturnType<typeof setup>) { void s.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.stop).handler(s.ctx); }

// ---- row and menu ----
test('SPEAK row shows Mac · <voice> with mac active, and the plain label otherwise', async () => {
  let s = setup({ patch: { macVoice: 'Eddy (Español (México))' } });
  await s.events.get('session_start')!({}, s.ctx);
  assert.match(s.statuses.at(-1)!, /^SPEAK ● on · modo todo · Mac · Eddy \(Español \(México\)\) · /);
  s.shutdown();
  s = setup();
  await s.events.get('session_start')!({}, s.ctx);
  assert.match(s.statuses.at(-1)!, / · Mac · Paulina · /);
  s.shutdown();
  s = setup({ voice: 'es_MX' });
  await s.events.get('session_start')!({}, s.ctx);
  assert.equal(s.statuses.at(-1)!.includes('Mac'), false);
  s.shutdown();
});

test('cycle key reaches mac once with say available, never without', async () => {
  const order = (say: boolean) => (async () => {
    const s = setup({ voice: 'es_MX', say, patch: {} });
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) { await s.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.cycleVoice).handler(s.ctx); seen.push(readSpeakSettings(s.home).voice); }
    s.shutdown(); return seen;
  })();
  const withSay = await order(true), withoutSay = await order(false);
  assert.equal(withSay.slice(0, 4).filter(v => v === 'mac').length, 1, 'one full cycle (es_MX, es_ES, mac, custom:intima) has mac once');
  assert.equal(withoutSay.includes('mac'), false);
});

test('/speak lists Mac, offers Mac voice and Toggle Mac fallback', async () => {
  const s = setup({ voice: 'es_MX' });
  await s.commands.get('speak').handler('', s.ctx);
  assert.ok(s.offered[0].includes('Voice: Mac (mac) — installed'));
  assert.ok(s.offered[0].includes('Voz del sistema')); assert.ok(s.offered[0].includes('Toggle Mac fallback'));
  const u = setup({ voice: 'es_MX', say: false });
  await u.commands.get('speak').handler('', u.ctx);
  assert.ok(u.offered[0].includes('Voice: Mac (mac) — not installed'));
});

test('/speak > Mac voice lists installed Spanish voices plus Auto, persists the choice and refreshes the row', async () => {
  const s = setup();
  s.selections.push('Voz del sistema', 'Mónica');
  await s.commands.get('speak').handler('', s.ctx);
  assert.deepEqual(s.offered[1], ['Auto', 'Paulina', 'Mónica', 'Eddy (Español (México))']);
  assert.equal(readSpeakSettings(s.home).macVoice, 'Mónica');
  assert.match(s.statuses.at(-1)!, / · Mac · Mónica · /);
  s.selections.push('Voz del sistema', 'Auto');
  await s.commands.get('speak').handler('', s.ctx);
  assert.equal(readSpeakSettings(s.home).macVoice, null);
  s.shutdown();
});

test('/speak > Mac voice with no voices installed changes nothing', async () => {
  const s = setup({ voices: [], patch: { macVoice: 'Paulina' } });
  const before = readFileSync(join(s.home, 'speak-settings.json'), 'utf8');
  s.selections.push('Voz del sistema');
  await s.commands.get('speak').handler('', s.ctx);
  assert.equal(readFileSync(join(s.home, 'speak-settings.json'), 'utf8'), before);
  assert.equal(s.notes.some(([t]) => /nothing changed/.test(t)), true);
});

test('/speak > Toggle Mac fallback flips and persists', async () => {
  const s = setup();
  assert.equal(readSpeakSettings(s.home).macFallback, true);
  s.selections.push('Toggle Mac fallback');
  await s.commands.get('speak').handler('', s.ctx);
  assert.equal(readSpeakSettings(s.home).macFallback, false);
  s.selections.push('Toggle Mac fallback');
  await s.commands.get('speak').handler('', s.ctx);
  assert.equal(readSpeakSettings(s.home).macFallback, true);
  s.shutdown();
});

test('/speak > selecting the Mac voice persists voice=mac when say is available; refused when not', async () => {
  const s = setup({ voice: 'es_MX' });
  s.selections.push('Voice: Mac (mac) — installed');
  await s.commands.get('speak').handler('', s.ctx);
  assert.equal(readSpeakSettings(s.home).voice, 'mac');
  const u = setup({ voice: 'es_MX', say: false });
  u.selections.push('Voice: Mac (mac) — not installed');
  await u.commands.get('speak').handler('', u.ctx);
  assert.equal(readSpeakSettings(u.home).voice, 'es_MX');
});

// ---- T33: T31 review advisories (L64) ----
test('R3-empty-voice-list-cached: an empty voice list is not cached; the next attempt lists again and speaks', async () => {
  let calls = 0;
  const s = setup({ voice: 'mac', listMac: async () => (++calls === 1 ? [] : VOICES) }); s.setSay('ok');
  const first = await s.tool();
  assert.equal(first.isError, true); assert.match(first.content[0].text, /^The Mac voice is not available/);
  assert.equal(s.sayCalls.length, 0);
  const second = await s.tool();
  assert.equal(second.isError, undefined); assert.equal(calls, 2, 'the empty result was not cached');
  assert.equal(s.sayCalls[0].voice, 'Paulina');
  await s.tool(); assert.equal(calls, 2, 'a non-empty list is still cached');
});

test('R3-qwen-error-suppressed-without-voice: Mac fallback cannot speak (no Spanish voice), so the original Qwen error reaches the user unchanged', async () => {
  const s = setup({ voice: 'custom:intima', qwen: 'missing', voices: [] });
  const tool = await s.tool();
  const original = tool.content[0].text;
  assert.match(original, /^Custom voice "intima" is not installed or is invalid\./); assert.equal(tool.isError, true);
  s.notes.length = 0;
  await s.settle(); await quiet();
  assert.deepEqual(s.notes, [[original, 'error']], 'automatic speech reports the original error exactly once');
  assert.equal(s.sayCalls.length, 0); assert.deepEqual(fallbackNotes(s), []);
});

test('R3: a failed Mac voice list (throws) also leaves the original Piper error untouched', async () => {
  const s = setup({ voice: 'es_MX', piper: 'missing', listMac: async () => { throw new Error('say broke'); } });
  const out = await s.tool();
  assert.equal(out.content[0].text, 'Install and verify the voice and runtime with /speak first.'); assert.equal(out.isError, true);
  await s.settle(); await quiet();
  assert.deepEqual(s.notes.filter(([, l]) => l === 'error'), [['Install and verify the voice and runtime with /speak first.', 'error']]);
});

test('R4-001: a hanging voice-list probe is bounded; speech does not block and treats the list as unavailable for that attempt', async () => {
  let calls = 0;
  const s = setup({ voice: 'custom:intima', qwen: 'missing', voiceProbeMs: 20, listMac: () => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve(VOICES); } }); s.setSay('ok');
  const started = Date.now();
  const out = await Promise.race([s.tool(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('speech blocked by the probe')), 2000))]);
  assert.ok(Date.now() - started < 1500);
  assert.equal(out.isError, true); assert.match(out.content[0].text, /^Custom voice "intima" is not installed/);
  assert.equal(s.sayCalls.length, 0);
  const again = await s.tool(); // the timeout was not cached: the next attempt lists again and falls back
  assert.equal(again.isError, undefined); assert.equal(calls, 2); assert.equal(s.sayCalls.length, 1);
});

// ---- T47 (S16): the system voice on Linux and Windows, same id and settings, platform label ----
const LINUX_VOICES = [{ name: 'spanish', locale: 'es' }, { name: 'spanish-latam', locale: 'es-419' }];
test('S16 label per platform: Mac on macOS, Sistema on Linux and Windows, in the row, the menu and the voice names', async () => {
  const s = setup({ platform: 'linux', voices: LINUX_VOICES });
  await s.events.get('session_start')!({}, s.ctx);
  assert.match(s.statuses.at(-1)!, / · Sistema · spanish-latam · /);
  await s.commands.get('speak').handler('', s.ctx);
  assert.ok(s.offered[0].includes('Voice: Sistema (mac) — installed'));
  assert.ok(s.offered[0].includes('Voz del sistema'));
  assert.equal(s.offered[0].some(o => o === 'Mac voice'), false);
  s.shutdown();
  const w = setup({ platform: 'win32', voices: [{ name: 'Microsoft Sabina Desktop', locale: 'es-MX' }] });
  await w.events.get('session_start')!({}, w.ctx);
  assert.match(w.statuses.at(-1)!, / · Sistema · Microsoft Sabina Desktop · /);
  w.shutdown();
});

test('S16 «Voz del sistema» lists the platform voices, persists macVoice and a Linux speech uses the picked voice', async () => {
  const s = setup({ platform: 'linux', voices: LINUX_VOICES });
  s.selections.push('Voz del sistema', 'spanish');
  await s.commands.get('speak').handler('', s.ctx);
  assert.deepEqual(s.offered[1], ['Auto', 'spanish', 'spanish-latam']);
  assert.equal(readSpeakSettings(s.home).macVoice, 'spanish');
  void s.tool('Hola Linux.'); await until(() => s.sayCalls.length === 1, 'say');
  assert.equal(s.sayCalls[0].voice, 'spanish');
  s.finishSay(); s.shutdown();
});

test('S16 Linux with nothing listed still speaks with the engine default «es»; Windows without voices does not speak', async () => {
  const l = setup({ platform: 'linux', voices: [] });
  void l.tool('Hola.'); await until(() => l.sayCalls.length === 1, 'say');
  assert.equal(l.sayCalls[0].voice, 'es');
  l.finishSay(); l.shutdown();
  const w = setup({ platform: 'win32', voices: [] });
  const out = await w.tool('Hola.');
  assert.equal(out.isError, true);
  assert.equal(w.sayCalls.length, 0);
  w.shutdown();
});

test('S16 the fallback notice names the system voice off macOS and still the Mac voice on macOS', async () => {
  const l = setup({ voice: 'es_MX', piper: 'missing', platform: 'linux', voices: LINUX_VOICES });
  void l.tool('Hola.'); await until(() => l.sayCalls.length === 1, 'say');
  assert.equal(l.notes.filter(([t]) => /speaking with the system voice/.test(t)).length, 1);
  l.finishSay(); l.shutdown();
  const m = setup({ voice: 'es_MX', piper: 'missing' });
  void m.tool('Hola.'); await until(() => m.sayCalls.length === 1, 'say');
  assert.equal(fallbackNotes(m).length, 1);
  m.finishSay(); m.shutdown();
});
