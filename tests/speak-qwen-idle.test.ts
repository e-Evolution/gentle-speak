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
// S13 / T37: idle release of the warm Qwen worker and transparent respawn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, parseSpeakSettingsFile, readSpeakSettings, writeSpeakSettings } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';
import { createQwenSpeech } from '../lib/speak-qwen.ts';
import { writeEntry } from './helpers/custom-voice-fixture.ts';

const QS = 'gentle.speak.qwen/v1', AS = 'gentle.speak/v1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (predicate: () => boolean) => { for (let i = 0; i < 300 && !predicate(); i++) await new Promise(r => setImmediate(r)); assert.ok(predicate(), 'condition not reached'); };
function fakeChild() {
  const writes: any[] = [];
  const state = { dead: false, ended: 0 };
  const child: any = Object.assign(new EventEmitter(), {
    stdin: { write: (line: string) => { if (state.dead) throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); writes.push(JSON.parse(line)); return true; }, end: () => { state.ended++; } },
    stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0,
    kill() { child.killed++; return true; },
  });
  return { child, writes, state, emit: (m: object) => child.stdout.emit('data', JSON.stringify(m) + '\n'), die: (silent = false) => { state.dead = true; if (!silent) child.emit('exit', null, 'SIGTERM'); } };
}
type Fake = ReturnType<typeof fakeChild>;
function direct(idleMs: number | null = 40) {
  const root = mkdtempSync(join(tmpdir(), 'speak-qwen-idle-'));
  const pythons: Fake[] = [], audios: Fake[] = [];
  const qwen = createQwenSpeech({ tmpRoot: root, idleMs, spawnPython: () => { const p = fakeChild(); pythons.push(p); return p.child; }, spawnAudio: () => { const a = fakeChild(); audios.push(a); return a.child; } } as any);
  const base = { python: '/fake/python3', ref: '/ref.wav', refText: 'ref', speed: 1 };
  const synths = (p: Fake) => p.writes.filter(w => w.type === 'synth');
  const chunk = (p: Fake, id: number, seq: number) => {
    const synth = synths(p).find(w => w.id === id); const wav = join(synth.outDir, `chunk-${id}-${seq}.wav`); writeFileSync(wav, 'RIFF');
    p.emit({ schema: QS, type: 'chunk', id, seq, wav, seconds: 1 }); return wav;
  };
  return { root, pythons, audios, qwen, base, synths, chunk, close: () => { qwen.dispose(); rmSync(root, { recursive: true, force: true }); } };
}
/** One finished prepare on the first worker (ready, synth, done). */
async function prepareDone(d: ReturnType<typeof direct>, idx = 0, id = 1) {
  const result = d.qwen.prepare({ ...d.base, text: 'Hola.' });
  await until(() => d.pythons.length > idx);
  if (idx === 0 || d.pythons[idx].writes.length === 0) { d.pythons[idx].emit({ schema: QS, type: 'ready' }); }
  await until(() => d.synths(d.pythons[idx]).some(w => w.id === id));
  d.pythons[idx].emit({ schema: QS, type: 'done', id });
  return result;
}

test('the warm worker is closed (stdin ended, killed) after idleMs without activity', async () => {
  const d = direct(40);
  try {
    assert.equal((await prepareDone(d)).ok, true);
    assert.equal(d.pythons[0].child.killed, 0);
    await sleep(15); assert.equal(d.pythons[0].child.killed, 0, 'not before idleMs');
    await sleep(80);
    assert.equal(d.pythons[0].child.killed, 1);
    assert.equal(d.pythons[0].state.ended, 1);
  } finally { d.close(); }
});

test('activity restarts the idle timer', async () => {
  const d = direct(80);
  try {
    await prepareDone(d);
    await sleep(50);
    const second = d.qwen.prepare({ ...d.base, text: 'Otra.' });
    await until(() => d.synths(d.pythons[0]).some(w => w.id === 2));
    d.pythons[0].emit({ schema: QS, type: 'done', id: 2 }); await second;
    await sleep(50); // 100 ms after the first, 50 after the second
    assert.equal(d.pythons[0].child.killed, 0, 'the second request restarted the timer');
    await sleep(80);
    assert.equal(d.pythons[0].child.killed, 1);
  } finally { d.close(); }
});

test('no idle close while a prepare is running or queued, nor mid-utterance', async () => {
  const d = direct(30);
  try {
    const running = d.qwen.prepare({ ...d.base, text: 'Uno.' });
    await until(() => d.pythons.length === 1);
    d.pythons[0].emit({ schema: QS, type: 'ready' });
    await until(() => d.synths(d.pythons[0]).length === 1);
    const queued = d.qwen.prepare({ ...d.base, text: 'Dos.' });
    await sleep(120);
    assert.equal(d.pythons[0].child.killed, 0, 'running prepare keeps the worker');
    d.pythons[0].emit({ schema: QS, type: 'done', id: 1 }); await running;
    await until(() => d.synths(d.pythons[0]).length === 2);
    await sleep(120);
    assert.equal(d.pythons[0].child.killed, 0, 'the queued prepare keeps the worker');
    d.pythons[0].emit({ schema: QS, type: 'done', id: 2 }); await queued;
    // speak: mid-utterance (chunk received, playback pending)
    const speaking = d.qwen.speak({ ...d.base, text: 'Tres.', runtime: '/rt' });
    await until(() => d.synths(d.pythons[0]).length === 3);
    d.chunk(d.pythons[0], 3, 0);
    await until(() => d.audios.length === 1);
    await sleep(120);
    assert.equal(d.pythons[0].child.killed, 0, 'never mid-utterance');
    d.pythons[0].emit({ schema: QS, type: 'done', id: 3 });
    d.audios[0].emit({ schema: AS, type: 'done', id: 1 });
    assert.deepEqual(await speaking, { ok: true });
    await sleep(100);
    assert.equal(d.pythons[0].child.killed, 1, 'closes after the utterance, idleMs later');
  } finally { d.close(); }
});

test('the next prepare after an idle close starts a fresh worker', async () => {
  const d = direct(30);
  try {
    await prepareDone(d);
    await sleep(100);
    assert.equal(d.pythons[0].child.killed, 1);
    d.pythons[0].child.emit('exit', 0, null); // the real child exits after the kill
    const result = d.qwen.prepare({ ...d.base, text: 'Otra.' });
    await until(() => d.pythons.length === 2);
    d.pythons[1].emit({ schema: QS, type: 'ready' });
    await until(() => d.synths(d.pythons[1]).length === 1);
    d.pythons[1].emit({ schema: QS, type: 'done', id: 2 });
    assert.equal((await result).ok, true);
  } finally { d.close(); }
});

test('a worker killed from outside while idle respawns on the next speak, with no failure', async () => {
  const d = direct(null);
  try {
    await prepareDone(d);
    d.pythons[0].die(); // SIGTERM: exit event, no request pending
    const speaking = d.qwen.speak({ ...d.base, text: 'Hola.', runtime: '/rt' });
    await until(() => d.pythons.length === 2);
    d.pythons[1].emit({ schema: QS, type: 'ready' });
    await until(() => d.synths(d.pythons[1]).length === 1);
    d.chunk(d.pythons[1], d.synths(d.pythons[1])[0].id, 0);
    await until(() => d.audios.length === 1);
    d.pythons[1].emit({ schema: QS, type: 'done', id: d.synths(d.pythons[1])[0].id });
    d.audios[0].emit({ schema: AS, type: 'done', id: 1 });
    assert.deepEqual(await speaking, { ok: true });
  } finally { d.close(); }
});

test('a write to a dead worker (EPIPE, no exit event seen yet) respawns and retries once before the request starts', async () => {
  const d = direct(null);
  try {
    await prepareDone(d);
    d.pythons[0].die(true); // stdin is broken, the exit event has not arrived
    const result = d.qwen.prepare({ ...d.base, text: 'Otra.' });
    await until(() => d.pythons.length === 2);
    assert.equal(d.pythons[0].child.killed >= 1, true, 'the dead worker is dropped');
    d.pythons[1].emit({ schema: QS, type: 'ready' });
    await until(() => d.synths(d.pythons[1]).length === 1);
    d.pythons[1].emit({ schema: QS, type: 'done', id: 2 });
    assert.equal((await result).ok, true);
    const speaking = d.qwen.speak({ ...d.base, text: 'Hola.', runtime: '/rt' });
    await until(() => d.synths(d.pythons[1]).length === 2);
    d.pythons[1].emit({ schema: QS, type: 'done', id: 3 });
    assert.deepEqual(await speaking, { ok: true });
    d.pythons[1].die(true);
    const again = d.qwen.speak({ ...d.base, text: 'Otra vez.', runtime: '/rt' });
    await until(() => d.pythons.length === 3);
    d.pythons[2].emit({ schema: QS, type: 'ready' });
    await until(() => d.synths(d.pythons[2]).length === 1);
    d.pythons[2].emit({ schema: QS, type: 'done', id: 4 });
    assert.deepEqual(await again, { ok: true });
  } finally { d.close(); }
});

test('a respawned worker that fails keeps today\'s failure (no second retry)', async () => {
  const d = direct(null);
  try {
    await prepareDone(d);
    d.pythons[0].die(true);
    const result = d.qwen.prepare({ ...d.base, text: 'Otra.' });
    await until(() => d.pythons.length === 2);
    d.pythons[1].die(); // the fresh worker exits before ready
    assert.deepEqual(await result, { ok: false, message: 'Qwen worker exited before speech finished.' });
    assert.equal(d.pythons.length, 2, 'only one respawn');
  } finally { d.close(); }
});

test('a spawn failure during the respawn reports today\'s error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'speak-qwen-idle-'));
  const pythons: Fake[] = []; let failNext = false;
  const qwen = createQwenSpeech({ tmpRoot: root, idleMs: null, spawnPython: () => { if (failNext) throw new Error('nope'); const p = fakeChild(); pythons.push(p); return p.child; }, spawnAudio: () => fakeChild().child } as any);
  try {
    const first = qwen.prepare({ python: '/p', text: 'Hola.', ref: '/r.wav', refText: 'r', speed: 1 });
    await until(() => pythons.length === 1);
    pythons[0].emit({ schema: QS, type: 'ready' });
    await until(() => pythons[0].writes.length === 1);
    pythons[0].emit({ schema: QS, type: 'done', id: 1 }); await first;
    pythons[0].die(true); failNext = true;
    assert.deepEqual(await qwen.prepare({ python: '/p', text: 'Otra.', ref: '/r.wav', refText: 'r', speed: 1 }), { ok: false, message: 'Qwen worker could not start.' });
  } finally { qwen.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('setIdleMs changes the timeout live; null means never', async () => {
  const d = direct(null);
  try {
    await prepareDone(d);
    await sleep(80); assert.equal(d.pythons[0].child.killed, 0, 'never');
    (d.qwen as any).setIdleMs(30);
    await sleep(100); assert.equal(d.pythons[0].child.killed, 1);
  } finally { d.close(); }
});

test('the idle timer never keeps the process alive (unref)', async () => {
  const d = direct(60_000);
  const real = global.setTimeout; const seen: boolean[] = [];
  (global as any).setTimeout = (fn: any, ms: any, ...a: any[]) => { const t = real(fn, ms, ...a); if (ms === 60_000) { const u = t.unref.bind(t); t.unref = () => { seen.push(true); return u(); }; } return t; };
  try { await prepareDone(d); } finally { (global as any).setTimeout = real; }
  try { assert.equal(seen.length >= 1, true); } finally { d.close(); }
});

// ---- settings ----
const withHome = (fn: (home: string) => void) => { const home = mkdtempSync(join(tmpdir(), 'speak-idle-set-')); try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); } };
test('qwenIdleMinutes defaults to 10, old files load with it, null and 1-60 are valid, anything else rejects the file', () => withHome(home => {
  assert.equal((DEFAULT_SPEAK_SETTINGS as any).qwenIdleMinutes, 10);
  const { qwenIdleMinutes: _q, ...old } = DEFAULT_SPEAK_SETTINGS as any;
  assert.equal(parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...old }))?.qwenIdleMinutes, 10);
  for (const good of [1, 2, 5, 60, null]) {
    writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, qwenIdleMinutes: good } as any, home);
    assert.equal(readSpeakSettings(home).qwenIdleMinutes, good);
  }
  for (const bad of [0, 61, 1.5, -1, '5', NaN, true]) {
    if (!Number.isNaN(bad)) assert.equal(parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...old, qwenIdleMinutes: bad })), undefined); // NaN has no JSON form
    assert.throws(() => writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, qwenIdleMinutes: bad } as any, home), /Invalid speak settings/);
  }
  assert.equal(readSpeakSettings(home).qwenIdleMinutes, null, 'rejected writes left the stored file unchanged');
}));

// ---- extension wiring: menu action, persistence, live update ----
function extensionHarness(minutes: number | null | undefined) {
  const home = mkdtempSync(join(tmpdir(), 'speak-idle-ext-'));
  const events = new Map<string, Function>(), commands = new Map<string, any>();
  const pythons: Fake[] = [];
  mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true });
  writeFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ python: '/fake/python3' }));
  writeEntry(join(home, 'voices', 'custom'), 'intima', { wav: Buffer.from('RIFF') }); // T45
  const settings: any = { schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, voice: 'custom:intima' };
  if (minutes === undefined) delete settings.qwenIdleMinutes; else settings.qwenIdleMinutes = minutes;
  writeFileSync(join(home, 'speak-settings.json'), JSON.stringify(settings));
  const offered: string[][] = []; const selections: string[] = []; const notes: string[] = [];
  const ctx: any = { mode: 'tui', hasUI: true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [] }, ui: { notify: (t: string) => notes.push(t), setStatus() {}, select: async (_t: string, o: string[]) => { offered.push(o); return selections.shift(); } } };
  const deps = { ...hermetic(home), modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn: () => fakeChild().child,
    spawnQwen: () => { const p = fakeChild(); pythons.push(p); return p.child; } };
  const tools = new Map<string, any>();
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut() {}, registerTool: (t: any) => tools.set(t.name, t) } as any, home, { focusCheck: async () => 'focused', sayAvailable: () => false, ...deps } as any);
  return { home, commands, events, tools, pythons, offered, selections, ctx, notes, close: () => rmSync(home, { recursive: true, force: true }) };
}
test('/speak offers "Mantener Qwen tras cerrar la última sesión" and persists the chosen minutes', async () => {
  const h = extensionHarness(5);
  try {
    h.selections.push('Mantener Qwen tras cerrar la última sesión', '10 min');
    await h.commands.get('speak').handler('', h.ctx);
    assert.ok(h.offered[0].includes('Mantener Qwen tras cerrar la última sesión'));
    assert.deepEqual(h.offered[1], ['1 min', '2 min', '5 min', '10 min', '30 min', '60 min', 'Nunca']);
    assert.equal(readSpeakSettings(h.home).qwenIdleMinutes, 10);
    h.selections.push('Mantener Qwen tras cerrar la última sesión', 'Nunca');
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(readSpeakSettings(h.home).qwenIdleMinutes, null);
    h.selections.push('Mantener Qwen tras cerrar la última sesión', undefined as any);
    await h.commands.get('speak').handler('', h.ctx);
    assert.equal(readSpeakSettings(h.home).qwenIdleMinutes, null, 'cancelling changes nothing');
  } finally { h.close(); }
});
test('the extension passes the setting to the worker and a change applies live, without restarting the session', async () => {
  const h = extensionHarness(1);
  const realSet = global.setTimeout; const delays: number[] = [];
  (global as any).setTimeout = (fn: any, ms: any, ...a: any[]) => { delays.push(ms); return realSet(fn, ms, ...a); };
  try {
    const run = async () => {
      const speaking = h.tools.get('speak').execute('id', { text: 'Hola mundo.' }, undefined, undefined, h.ctx);
      await until(() => h.pythons.length > 0);
      const p = h.pythons[0], synths = () => p.writes.filter(w => w.type === 'synth');
      const wanted = synths().length + 1;
      if (wanted === 1) p.emit({ schema: QS, type: 'ready' });
      await until(() => synths().length === wanted);
      p.emit({ schema: QS, type: 'done', id: synths().at(-1).id });
      await speaking;
    };
    await run();
    assert.ok(delays.includes(60_000), 'one minute became 60000 ms');
    h.selections.push('Mantener Qwen tras cerrar la última sesión', '30 min');
    await h.commands.get('speak').handler('', h.ctx);
    delays.length = 0;
    const count = h.pythons.length;
    await run();
    assert.equal(h.pythons.length, count, 'same warm worker, session not restarted');
    assert.ok(delays.includes(30 * 60_000), 'the new value applies live');
  } finally { (global as any).setTimeout = realSet; h.events.get('session_shutdown')?.({}, h.ctx); h.close(); }
});
