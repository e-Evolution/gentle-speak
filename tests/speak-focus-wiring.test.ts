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
import { test } from 'node:test';
import fs, { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';

// S9 wiring: focus deferral, one voice across sessions (shared lock dir), project prefix. All fakes; no herdr, osascript or audio.
// No wall-clock sleeps decide an outcome: positive results wait on a condition (bounded by a deadline, so a regression fails fast
// instead of hanging); absence of an effect is proven after N further focus checks or lock polls, counted, not timed.
const until = async (cond: () => boolean, what = 'condition') => {
  const deadline = Date.now() + 5000;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 1)); }
};
/** Absence window for effects that must NOT happen while nothing is polling; it never decides a positive outcome. */
const quiet = (ms = 30) => new Promise(r => setTimeout(r, ms));
const checks = (s: { state: { checks: number } }, n = 4) => { const goal = s.state.checks + n; return until(() => s.state.checks >= goal, `${n} focus checks`); };
/** Counts the lock polls other sessions make (they look at voice.lock every lockPollMs while waiting). */
const lockPolls = (n: number, home: string) => { let seen = 0; const real = fs.existsSync; (fs as any).existsSync = (f: any) => { if (f === join(home, 'voice.lock')) seen++; return real(f); }; return until(() => seen >= n, `${n} lock polls`).finally(() => { (fs as any).existsSync = real; }); };
const msg = (text: string) => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }];
const keys = DEFAULT_SPEAK_SETTINGS.shortcuts;
const roots: string[] = [];
const sharedHome = () => { const h = mkdtempSync(join(tmpdir(), 'speak-wiring-')); roots.push(h); return h; };
const save = (home: string, patch: Record<string, unknown> = {}) => writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all', ...patch }));
const lockHeld = (home: string) => existsSync(join(home, 'voice.lock'));

function session(home: string, opts: { focus?: () => string | Promise<string>; text?: string; cwd?: string; deps?: any; mode?: string } = {}) {
  const state = { focus: 'focused', branch: msg(opts.text ?? 'Resultado listo.'), checks: 0 };
  const children: any[] = [];
  const shortcuts = new Map<string, any>(); const events = new Map<string, Function>(); const tools = new Map<string, any>();
  const spawn = () => {
    const c: any = Object.assign(new EventEmitter(), { writes: [] as string[], killed: 0, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.killed++; return true; } });
    c.stdin = { write: (l: string) => { c.writes.push(l); return true; } };
    children.push(c); return c;
  };
  const notes: string[] = [];
  const ctx: any = { cwd: opts.cwd ?? '/work/gentle-theme', mode: opts.mode ?? 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => state.branch },
    ui: { setStatus() {}, notify: (t: string) => notes.push(t), confirm: async () => false, select: async () => undefined, input: async () => undefined } };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut: (k: string, s: any) => shortcuts.set(k, s), registerTool: (t: any) => tools.set(t.name, t) } as any, home, {
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn,
    focusCheck: opts.focus ?? (async () => { state.checks++; return state.focus as any; }), focusPollMs: 5, lockPollMs: 5, sayAvailable: () => false, ...hermetic(home), ...opts.deps } as any);
  const settle = () => events.get('agent_settled')!({ aborted: false }, ctx);
  const finish = (c: any) => c.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: JSON.parse(c.writes[0]).id }) + '\n');
  const texts = () => children.filter(c => c.writes.length).map(c => JSON.parse(c.writes[0]).text);
  const tool = (text: string, signal?: AbortSignal) => tools.get('speak').execute('id', { text }, signal, undefined, ctx);
  return { state, children, shortcuts, events, ctx, notes, settle, finish, texts, tool, shutdown: () => events.get('session_shutdown')!({}, ctx) };
}
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

test('focused: automatic speech plays at once with the exact text', async () => {
  const home = sharedHome(); save(home); const s = session(home);
  const p = s.settle(); await until(() => s.texts().length === 1, 'speech');
  assert.deepEqual(s.texts(), ['Resultado listo.']);
  s.finish(s.children[0]); await p; s.shutdown();
});

test('unfocused: nothing plays, then exactly once after focus arrives; polling stops afterwards', async () => {
  const home = sharedHome(); save(home); const s = session(home); s.state.focus = 'unfocused';
  const p = s.settle(); await p; await checks(s);
  assert.deepEqual(s.children, []);
  assert.ok(s.state.checks > 1, 'polls while an item is pending');
  s.state.focus = 'focused'; await until(() => s.texts().length === 1, 'speech after focus');
  assert.deepEqual(s.texts(), ['Resultado listo.']);
  const after = s.state.checks; await quiet();
  assert.equal(s.state.checks, after, 'no polling once nothing is pending');
  assert.equal(s.children.length, 1);
  s.finish(s.children[0]); s.shutdown();
});

test('two unfocused results leave only the latest, spoken once', async () => {
  const home = sharedHome(); save(home); const s = session(home, { text: 'Primero.' }); s.state.focus = 'unfocused';
  await s.settle(); s.state.branch = msg('Segundo.'); await s.settle(); s.state.branch = msg('Tercero.'); await s.settle();
  s.state.focus = 'focused'; await until(() => s.texts().length === 1, 'latest only');
  assert.deepEqual(s.texts(), ['Tercero.']);
  await quiet(); assert.equal(s.children.length, 1);
  s.finish(s.children[0]); s.shutdown();
});

test('unknown focus speaks in turn with the exact "<basename>: " prefix', async () => {
  const home = sharedHome(); save(home); const s = session(home, { cwd: '/home/u/gentle-theme/' }); s.state.focus = 'unknown';
  const p = s.settle(); await until(() => s.texts().length === 1, 'speech');
  assert.deepEqual(s.texts(), ['gentle-theme: Resultado listo.']);
  s.finish(s.children[0]); await p; s.shutdown();
});

test('the model-callable speak tool: focused speaks and returns the outcome; unfocused defers then speaks once; unknown prefixes', async () => {
  const home = sharedHome(); save(home); const s = session(home);
  const a = s.tool('Hola ahora'); await until(() => s.texts().length === 1, 'speech');
  assert.deepEqual(s.texts(), ['Hola ahora']);
  s.finish(s.children[0]); assert.equal((await a).isError, undefined); assert.equal((await a).content[0].text, 'Speech completed.');
  s.state.focus = 'unfocused';
  const b = await s.tool('Hola luego');
  assert.equal(b.isError, undefined); assert.match(b.content[0].text, /deferred/i); assert.equal(s.children.length, 1);
  s.state.focus = 'focused'; await until(() => s.texts().length === 2, 'deferred speech');
  assert.deepEqual(s.texts(), ['Hola ahora', 'Hola luego']);
  s.finish(s.children[1]); await until(() => !lockHeld(home), 'lock released');
  s.state.focus = 'unknown';
  const c = s.tool('Hola turno'); await until(() => s.children.length === 3 && s.children[2].writes.length === 1, 'prefixed speech');
  assert.equal(JSON.parse(s.children[2].writes[0]).text, 'gentle-theme: Hola turno');
  s.finish(s.children[2]); await c; s.shutdown();
});

test('speak-last and copy speech bypass the deferral (but not the single voice)', async () => {
  const home = sharedHome(); save(home, { copySpeech: true });
  const watchers: any[] = [];
  const s = session(home, { deps: { resolveTerminal: async () => 'com.term', createWatcher: (o: any) => { watchers.push(o); return { start() {}, stop() {} }; } } });
  (s.ctx.ui as any).setWidget = (_k: string, f: any) => { f({ getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => [] }, {}); };
  s.state.focus = 'unfocused';
  await s.events.get('session_start')!({ reason: 'startup' }, s.ctx); await until(() => watchers.length === 1, 'watcher');
  s.shortcuts.get(keys.speakLast).handler(s.ctx); await until(() => s.texts().length === 1, 'speak last');
  assert.deepEqual(s.texts(), ['Resultado listo.']);
  watchers[0].speak('copiado'); await until(() => s.children.length === 2 && s.children[1].writes.length === 1, 'copy speech');
  assert.equal(s.children.length, 2, 'copy speech superseded the first and spoke at once');
  assert.equal(JSON.parse(s.children[1].writes[0]).text, 'copiado');
  s.shutdown();
});

test('two sessions sharing one lock dir never overlap playback', async () => {
  const home = sharedHome(); save(home);
  const a = session(home, { text: 'De A.' }), b = session(home, { text: 'De B.' });
  const pa = a.settle(); await until(() => a.texts().length === 1, 'A speaks');
  const pb = b.settle(); await lockPolls(4, home);
  assert.equal(a.children.length, 1); assert.equal(b.children.length, 0, 'B waits for the single voice');
  a.finish(a.children[0]); await pa; await until(() => b.texts().length === 1, 'B speaks after A');
  assert.deepEqual(b.texts(), ['De B.']);
  b.finish(b.children[0]); await pb; await until(() => !lockHeld(home), 'lock released');
  assert.equal(lockHeld(home), false);
  a.shutdown(); b.shutdown();
});

test('stop aborts a waiting acquire and never blocks or kills another session', async () => {
  const home = sharedHome(); save(home);
  const a = session(home, { text: 'De A.' }), b = session(home, { text: 'De B.' });
  const pa = a.settle(); await until(() => a.texts().length === 1, 'A speaks');
  const pb = b.tool('De B tool'); await lockPolls(3, home);
  b.shortcuts.get(keys.stop).handler(b.ctx);
  const out = await pb;
  assert.equal(out.isError, true); assert.equal(out.content[0].text, 'Speech cancelled.');
  assert.equal(a.children[0].killed, 0, 'B stop does not touch A');
  a.finish(a.children[0]); await pa; await until(() => !lockHeld(home), 'lock released'); await quiet();
  assert.equal(b.children.length, 0, 'the aborted waiter never takes the lock');
  assert.equal(lockHeld(home), false);
  a.shutdown(); b.shutdown();
});

test('stop releases a held lock; a new own utterance supersedes the old one and releases it', async () => {
  const home = sharedHome(); save(home);
  const s = session(home);
  const p1 = s.tool('uno'); await until(() => lockHeld(home) && s.children.length === 1 && s.children[0].writes.length === 1, 'first playback');
  assert.equal(lockHeld(home), true);
  s.shortcuts.get(keys.stop).handler(s.ctx); await p1;
  assert.equal(s.children[0].killed >= 1, true); assert.equal(lockHeld(home), false);
  const p2 = s.tool('dos'); await until(() => s.children.length === 2 && s.children[1].writes.length === 1, 'second playback');
  const p3 = s.tool('tres'); await until(() => s.children.length === 3 && s.children[2].writes.length === 1, 'third playback');
  assert.equal(s.children[1].killed >= 1, true); assert.equal((await p2).content[0].text, 'Speech cancelled.');
  assert.equal(JSON.parse(s.children[2].writes[0]).text, 'tres'); assert.equal(lockHeld(home), true);
  s.finish(s.children[2]); await p3; await until(() => !lockHeld(home), 'lock released');
  assert.equal(lockHeld(home), false);
  s.shutdown();
});

test('a playback failure releases the lock', async () => {
  const home = sharedHome(); save(home); const s = session(home);
  const p = s.tool('uno'); await until(() => s.children.length === 1 && s.children[0].writes.length === 1, 'playback');
  s.children[0].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'error', id: 1 }) + '\n');
  assert.equal((await p).isError, true); await until(() => !lockHeld(home), 'lock released');
  assert.equal(lockHeld(home), false); s.shutdown();
});

test('shutdown disposes the deferral, aborts a waiting acquire, releases the lock and nothing speaks afterwards', async () => {
  const home = sharedHome(); save(home);
  const a = session(home, { text: 'De A.' }), pending = session(home, { text: 'Pendiente.' }), waiter = session(home);
  pending.state.focus = 'unfocused'; await pending.settle();
  const pa = a.settle(); await until(() => a.texts().length === 1, 'A speaks');
  const pw = waiter.tool('espera'); await lockPolls(3, home);
  a.shutdown(); pending.shutdown(); waiter.shutdown();
  assert.equal(a.children[0].killed >= 1, true); assert.equal(lockHeld(home), false);
  assert.equal((await pw).isError, true);
  pending.state.focus = 'focused'; await quiet();
  assert.equal(pending.children.length, 0); assert.equal(waiter.children.length, 0);
  assert.equal((await waiter.tool('tarde')).isError, true); assert.equal(waiter.children.length, 0);
  await pa;
});

test('toggle off and the stop key clear the pending item', async () => {
  const home = sharedHome(); save(home);
  const s = session(home); s.state.focus = 'unfocused';
  await s.settle();
  s.shortcuts.get(keys.toggle).handler(s.ctx); await quiet(10);
  s.state.focus = 'focused'; await quiet();
  assert.equal(s.children.length, 0);
  save(home); s.state.focus = 'unfocused'; await s.settle();
  s.shortcuts.get(keys.stop).handler(s.ctx);
  s.state.focus = 'focused'; await quiet();
  assert.equal(s.children.length, 0); s.shutdown();
});

test('default focus check combines Herdr with the terminal-frontmost bundle id; unidentifiable means unknown (prefix)', async () => {
  const cases: Array<[any, 'now' | 'deferred' | 'prefix']> = [
    [{ terminal: 'com.t', front: 'com.t' }, 'now'],
    [{ terminal: 'com.t', front: 'com.other' }, 'deferred'],
    [{ herdr: false, terminal: 'com.t', front: 'com.t' }, 'deferred'],
    [{ terminal: 'com.t', front: undefined }, 'prefix'],
    [{ terminal: undefined, front: 'com.t' }, 'prefix'],
    [{ env: {} , terminal: 'com.t', front: 'com.t' }, 'prefix'],
  ];
  for (const [o, expected] of cases) {
    const home = sharedHome(); save(home);
    const execs: string[][] = [];
    const t = mkReal(home, o, execs);
    const p = t.settle(); await (expected === 'deferred' ? until(() => execs.length >= 1, 'herdr probe').then(() => quiet(10)) : until(() => t.texts().length === 1, 'speech'));
    if (expected === 'deferred') assert.equal(t.children.length, 0, JSON.stringify(o));
    else assert.deepEqual(t.texts(), [expected === 'now' ? 'Resultado listo.' : 'gentle-theme: Resultado listo.'], JSON.stringify(o));
    if (o.env === undefined) assert.deepEqual(execs[0]?.slice(0, 3), ['herdr', 'pane', 'get']);
    t.shutdown(); await p;
  }
});

function mkReal(home: string, o: any, execs: string[][]) {
  const children: any[] = []; const events = new Map<string, Function>();
  const ctx: any = { cwd: '/work/gentle-theme', mode: 'tui', hasUI: true, isIdle: () => true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => msg('Resultado listo.') }, ui: { setStatus() {}, notify() {}, confirm: async () => false, select: async () => undefined, input: async () => undefined } };
  const spawn = () => { const c: any = Object.assign(new EventEmitter(), { writes: [] as string[], stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }); c.stdin = { write: (l: string) => { c.writes.push(l); return true; } }; children.push(c); return c; };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool() {} } as any, home, {
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn,
    userHome: home, processHome: home, env: o.env ?? { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }, focusPollMs: 1000, lockPollMs: 5, sayAvailable: () => false,
    herdrExec: async (f: string, a: string[]) => { execs.push([f, ...a]); if (o.hang) return new Promise<string>(() => {}); return JSON.stringify({ result: { pane: { focused: o.herdr ?? true } } }); },
    resolveTerminal: async () => o.terminal, readFrontmost: async () => o.front } as any);
  return { children, settle: () => events.get('agent_settled')!({ aborted: false }, ctx), texts: () => children.filter(c => c.writes.length).map(c => JSON.parse(c.writes[0]).text), shutdown: () => events.get('session_shutdown')!({}, ctx) };
}

test('shutdown with a playback in flight and a waiter pending: the lock ends released, nothing acquires afterwards', async () => {
  const home = sharedHome(); save(home);
  const a = session(home, { text: 'De A.' }), b = session(home, { text: 'De B.' });
  const pa = a.settle(); await until(() => a.texts().length === 1, 'A speaks');
  const pb = b.settle(); await lockPolls(2, home);
  b.shutdown(); // B's pending acquire is aborted
  a.shutdown(); // A's playback in flight: killed, lock released exactly once
  await until(() => !lockHeld(home), 'lock released');
  await pa; await pb; await quiet();
  assert.equal(lockHeld(home), false, 'no acquire completed after shutdown');
  assert.equal(b.children.length, 0);
  a.shutdown(); // a second shutdown (/reload twice) is harmless
  assert.equal(lockHeld(home), false);
});

test('a hanging Herdr probe is bounded: focus is unknown, so speech proceeds in turn with the project prefix', async () => {
  const home = sharedHome(); save(home);
  const t = mkReal(home, { terminal: 'com.t', front: 'com.t', hang: true }, []);
  const p = t.settle();
  await until(() => t.texts().length === 1, 'prefixed speech after the probe bound');
  assert.deepEqual(t.texts(), ['gentle-theme: Resultado listo.']);
  t.shutdown(); await p;
});
