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
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';

// T46 wiring: terminal focus events wake the S9 deferral; no wrap outside the parent fullscreen TUI. Fakes only; no Herdr, osascript or audio.
// The poll is set to ~infinity, so any delivery in these tests came from the focus event, never from polling.
const until = async (cond: () => boolean, what = 'condition') => {
  const deadline = Date.now() + 5000;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 1)); }
};
const quiet = (ms = 30) => new Promise(r => setTimeout(r, ms));
const msg = (text: string) => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }];
const IN = '\x1b[I', OUT = '\x1b[O', RESULT = { consume: true };
const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

class FakeTui {
  calls: unknown[][] = [];
  getCopyOnSelect() { return true; }
  hasActiveSelection() { return false; }
  getScreenLines() { return ['x']; }
  handleViewportInput(...args: unknown[]) { this.calls.push(args); return RESULT; }
}
const proto = FakeTui.prototype.handleViewportInput;

type Opts = { mode?: string; header?: any; tui?: unknown; dot?: boolean; settings?: Record<string, unknown>; focusCheck?: () => Promise<any> };
function world(o: Opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'speak-tfocus-')); roots.push(base);
  const home = join(base, 'speak'); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all', ...o.settings }));
  const tui = 'tui' in o ? o.tui : new FakeTui();
  const state = { branch: msg('Resultado listo.') };
  const children: any[] = [], events = new Map<string, Function>(), tools = new Map<string, any>(), widgets: string[] = [], watchers: any[] = [];
  const spawn = () => {
    const c: any = Object.assign(new EventEmitter(), { writes: [] as string[], stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } });
    c.stdin = { write: (l: string) => { c.writes.push(l); return true; } }; children.push(c); return c;
  };
  const ctx: any = { cwd: '/work/gentle-theme', mode: o.mode ?? 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => o.header ?? { type: 'session' }, getBranch: () => state.branch },
    ui: { setStatus() {}, notify() {}, confirm: async () => false, select: async () => undefined, input: async () => undefined,
      setWidget: (key: string, factory: any) => { widgets.push(key); if (typeof factory === 'function') factory(tui, {}); } } };
  const sandbox = hermetic(home);
  const processEnv = o.dot ? { ...sandbox.env, GENTLE_SPEAK_DOT: '1' } : sandbox.env;
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool: (t: any) => tools.set(t.name, t) } as any, home, {
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn,
    focusPollMs: 1_000_000, lockPollMs: 5, sayAvailable: () => false, resolveTerminal: async () => 'com.t', readFrontmost: async () => undefined,
    createWatcher: ((w: any) => { watchers.push(w); return { start() {}, stop() {} }; }) as any,
    ...sandbox, env: processEnv, focusCheck: o.focusCheck, ...(o.dot ? { settingsHome: home } : {}),
  } as any);
  const start = async () => { await events.get('session_start')!({ reason: 'startup' }, ctx); await quiet(5); };
  const settle = () => events.get('agent_settled')!({ aborted: false }, ctx);
  const texts = () => children.filter(c => c.writes.length).map(c => JSON.parse(c.writes[0]).text);
  const finish = (c: any) => c.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: JSON.parse(c.writes[0]).id }) + '\n');
  return { home, tui: tui as any, ctx, children, events, tools, widgets, watchers, start, settle, texts, finish, shutdown: () => events.get('session_shutdown')!({}, ctx) };
}
const wrapped = (tui: any) => Object.prototype.hasOwnProperty.call(tui, 'handleViewportInput');

test('focus-in wakes the deferred result without any poll; out keeps it pending; delivered once', async () => {
  const w = world(); await w.start();
  assert.ok(wrapped(w.tui), 'the live TUI instance is wrapped');
  assert.equal(w.tui.handleViewportInput(OUT), RESULT);
  await w.settle(); await quiet(); assert.deepEqual(w.children, [], 'unfocused: held');
  assert.equal(w.tui.handleViewportInput(IN), RESULT);
  await until(() => w.texts().length === 1, 'speech on focus-in');
  assert.deepEqual(w.texts(), ['Resultado listo.'], 'exact text, no project prefix');
  w.tui.handleViewportInput(OUT); w.tui.handleViewportInput(IN); await quiet(); assert.equal(w.children.length, 1, 'delivered once');
  w.finish(w.children[0]); w.shutdown();
  assert.deepEqual(w.tui.calls, [[OUT], [IN], [OUT], [IN]], 'every input reached the original, in order');
});

test('after a focus-out, typing means focus again and wakes the deferred result', async () => {
  const w = world(); await w.start();
  w.tui.handleViewportInput(OUT); await w.settle(); await quiet(); assert.deepEqual(w.children, []);
  w.tui.handleViewportInput('a'); await until(() => w.texts().length === 1, 'speech after typing');
  w.finish(w.children[0]); w.shutdown();
});

test('no event, no typing: focus unknown keeps today\'s turn with the project prefix', async () => {
  const w = world(); await w.start();
  const p = w.settle(); await until(() => w.texts().length === 1, 'speech');
  assert.deepEqual(w.texts(), ['gentle-theme: Resultado listo.']);
  w.finish(w.children[0]); await p; w.shutdown();
});

test('shutdown restores the original method on the instance', async () => {
  const w = world(); await w.start(); assert.notEqual(w.tui.handleViewportInput, proto);
  w.shutdown(); assert.equal(wrapped(w.tui), false); assert.equal(w.tui.handleViewportInput, proto);
  assert.equal(w.tui.handleViewportInput(OUT), RESULT);
});

test('a second session_start (/reload) replaces the tracker: one wrapper level', async () => {
  const w = world(); await w.start(); const first = w.tui.handleViewportInput; await w.start();
  assert.notEqual(w.tui.handleViewportInput, first); w.tui.handleViewportInput(IN); assert.equal(w.tui.calls.length, 1, 'delegates once, not twice');
  w.shutdown(); assert.equal(w.tui.handleViewportInput, proto);
});

test('a TUI without handleViewportInput is left untouched and focus stays unknown (prefix turn)', async () => {
  const tui = { getCopyOnSelect: () => true, hasActiveSelection: () => false, getScreenLines: () => ['x'] };
  const w = world({ tui }); await w.start();
  assert.deepEqual(Object.keys(tui).sort(), ['getCopyOnSelect', 'getScreenLines', 'hasActiveSelection']);
  const p = w.settle(); await until(() => w.texts().length === 1); assert.deepEqual(w.texts(), ['gentle-theme: Resultado listo.']);
  w.finish(w.children[0]); await p; w.shutdown();
});

for (const [name, o] of [
  ['print mode', { mode: 'print' }], ['json mode', { mode: 'json' }], ['rpc mode', { mode: 'rpc' }],
  ['a child session (has a parent session)', { header: { type: 'session', parentSession: '/p.jsonl' } }],
] as Array<[string, Opts]>) test(`never wraps: ${name}`, async () => {
  const w = world(o); await w.start();
  assert.equal(w.widgets.includes('gentle-speak-focus'), false); assert.equal(wrapped(w.tui), false); w.shutdown();
});

test('Dot\'s RPC session keeps S12: speaks at once with the Dot prefix, never wraps, never consults focus', async () => {
  let checks = 0;
  const w = world({ mode: 'rpc', dot: true, settings: { dotSpeech: true }, focusCheck: async () => { checks++; return 'unfocused'; } }); await w.start();
  assert.equal(wrapped(w.tui), false);
  const p = w.settle(); await until(() => w.texts().length === 1, 'speech'); assert.deepEqual(w.texts(), ['Dot: Resultado listo.']); assert.equal(checks, 0);
  w.finish(w.children[0]); await p; w.shutdown();
});

test('preserve S9: an injected focus check still decides and is polled/woken until it says focused', async () => {
  let focus = 'unfocused'; let checks = 0;
  const w = world({ focusCheck: async () => { checks++; return focus; } }); await w.start();
  await w.settle(); await quiet(); assert.deepEqual(w.children, []);
  w.tui.handleViewportInput(IN); await until(() => checks >= 2, 'a wake-up check'); assert.deepEqual(w.children, [], 'the check still says unfocused');
  focus = 'focused'; w.tui.handleViewportInput(OUT); w.tui.handleViewportInput(IN); await until(() => w.texts().length === 1, 'speech once the check says focused');
  w.finish(w.children[0]); w.shutdown();
});

test('preserve voice lock: a focus-woken playback holds the one cross-process lock until it ends', async () => {
  const w = world(); await w.start(); w.tui.handleViewportInput(OUT); await w.settle();
  w.tui.handleViewportInput(IN); await until(() => w.texts().length === 1, 'speech');
  assert.ok(existsSync(join(w.home, 'voice.lock')), 'lock held during playback');
  w.finish(w.children[0]); await until(() => !existsSync(join(w.home, 'voice.lock')), 'lock released'); w.shutdown();
});

test('preserve copy speech: the watcher still starts and shares the TUI the focus tracker wrapped', async () => {
  const w = world({ settings: { copySpeech: true } }); await w.start();
  assert.equal(w.watchers.length, 1); assert.ok(w.widgets.includes('gentle-speak-copy')); assert.ok(w.widgets.includes('gentle-speak-focus'));
  assert.equal(w.watchers[0].isOwnCopy('x'), false, 'no active selection on the fake: not an own copy');
  w.shutdown();
});
