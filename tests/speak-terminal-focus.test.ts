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
import { createTerminalFocusTracker, FOCUS_IN, FOCUS_OUT } from '../lib/speak-terminal-focus.ts';
import { createFocusCheck, createLatestOnlyDeferral, type FocusState } from '../lib/speak-focus.ts';

// T46 (S16, S9): terminal focus events read by wrapping the live TUI instance. Fake TUI only; no pi-tui, no terminal, no clock sleeps.
const RESULT = { consume: true };
class FakeTui {
  calls: Array<{ args: unknown[]; self: unknown }> = [];
  getCopyOnSelect() { return true; }
  hasActiveSelection() { return false; }
  getScreenLines() { return ['x']; }
  handleViewportInput(...args: unknown[]) { this.calls.push({ args, self: this }); return RESULT; }
}
const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; };
const proto = FakeTui.prototype.handleViewportInput;

test('the wrapper observes in and out and always delegates the same args, this and return value', () => {
  const tui = new FakeTui(); const t = createTerminalFocusTracker(tui);
  assert.equal(t.attached, true); assert.equal(t.state(), 'unknown'); assert.equal(t.hasEvents(), false);
  assert.equal(tui.handleViewportInput(FOCUS_OUT), RESULT); assert.equal(t.state(), 'unfocused'); assert.equal(t.hasEvents(), true);
  assert.equal(tui.handleViewportInput(FOCUS_IN), RESULT); assert.equal(t.state(), 'focused');
  const extra = {}; assert.equal((tui.handleViewportInput as any)('a', extra), RESULT);
  assert.deepEqual(tui.calls.map(c => c.args), [[FOCUS_OUT], [FOCUS_IN], ['a', extra]]);
  assert.ok(tui.calls.every(c => c.self === tui), 'this is the instance');
  assert.equal(FakeTui.prototype.handleViewportInput, proto, 'the prototype is never touched');
  assert.ok(Object.prototype.hasOwnProperty.call(tui, 'handleViewportInput'), 'wrapped on the instance');
  t.dispose();
});

test('listeners are told only about changes, and a throwing listener never breaks input', () => {
  const tui = new FakeTui(); const t = createTerminalFocusTracker(tui); const seen: FocusState[] = [];
  t.onChange(s => seen.push(s)); t.onChange(() => { throw new Error('boom'); });
  tui.handleViewportInput(FOCUS_OUT); tui.handleViewportInput(FOCUS_OUT); assert.equal(tui.handleViewportInput(FOCUS_IN), RESULT);
  assert.deepEqual(seen, ['unfocused', 'focused']); assert.equal(tui.calls.length, 3);
  t.dispose();
});

test('typing implies focus: input sets focused, and with no events focus lasts 60 s after the last input', () => {
  const c = clock(); const tui = new FakeTui(); const t = createTerminalFocusTracker(tui, { now: c.now });
  assert.equal(t.state(), 'unknown');
  tui.handleViewportInput('x'); assert.equal(t.state(), 'focused'); assert.equal(t.hasEvents(), false);
  c.advance(59_999); assert.equal(t.state(), 'focused');
  c.advance(2); assert.equal(t.state(), 'unknown', 'past the window with no focus event');
  tui.handleViewportInput('\x1b[<0;5;5M'); assert.equal(t.state(), 'focused', 'mouse input counts too');
  t.dispose();
});

test('typing after a focus-out means the terminal is focused again', () => {
  const tui = new FakeTui(); const t = createTerminalFocusTracker(tui);
  tui.handleViewportInput(FOCUS_OUT); assert.equal(t.state(), 'unfocused');
  tui.handleViewportInput('a'); assert.equal(t.state(), 'focused'); assert.equal(t.hasEvents(), true);
  t.dispose();
});

for (const [name, make] of [
  ['no handleViewportInput', () => ({ getCopyOnSelect() {}, hasActiveSelection() {}, getScreenLines() {} })],
  ['handleViewportInput is not a function', () => ({ getCopyOnSelect() {}, hasActiveSelection() {}, getScreenLines() {}, handleViewportInput: 1 })],
  ['not a fullscreen TUI', () => ({ handleViewportInput() { return 1; } })],
  ['undefined', () => undefined],
] as Array<[string, () => any]>) test(`detection failure (${name}): unknown forever, logged once, nothing touched`, () => {
  const tui = make(); const before = tui && Object.getOwnPropertyDescriptors(tui); const logs: string[] = [];
  const t = createTerminalFocusTracker(tui, { log: m => logs.push(m) });
  assert.equal(t.attached, false); assert.equal(t.state(), 'unknown'); assert.equal(t.hasEvents(), false);
  assert.equal(logs.length, 1);
  if (tui) assert.deepEqual(Object.getOwnPropertyDescriptors(tui), before);
  t.dispose(); t.dispose(); assert.equal(logs.length, 1);
});

test('dispose restores the original: deleted when it was inherited, reassigned when it was own; idempotent', () => {
  const inherited = new FakeTui(); const a = createTerminalFocusTracker(inherited); a.dispose(); a.dispose();
  assert.equal(Object.prototype.hasOwnProperty.call(inherited, 'handleViewportInput'), false);
  assert.equal(inherited.handleViewportInput, proto);
  const own = new FakeTui(); const fn = function (this: unknown) { return RESULT; }; (own as any).handleViewportInput = fn;
  const b = createTerminalFocusTracker(own); assert.notEqual(own.handleViewportInput, fn); b.dispose(); assert.equal(own.handleViewportInput, fn);
  const seen: FocusState[] = []; const c = createTerminalFocusTracker(inherited); c.onChange(s => seen.push(s)); c.dispose();
  inherited.handleViewportInput(FOCUS_OUT); assert.deepEqual(seen, []); assert.equal(c.state(), 'unknown');
});

test('dispose leaves a wrapper installed on top of ours intact', () => {
  const tui = new FakeTui(); const t = createTerminalFocusTracker(tui); const ours = tui.handleViewportInput;
  const top = function (this: any, ...a: unknown[]) { return (ours as any).apply(this, a); }; (tui as any).handleViewportInput = top;
  t.dispose(); assert.equal(tui.handleViewportInput, top);
  assert.equal(tui.handleViewportInput(FOCUS_OUT), RESULT, 'the chain still delegates');
});

test('focus check priority: terminal events beat Herdr and frontmost', async () => {
  const tui = new FakeTui(); const t = createTerminalFocusTracker(tui); let herdr = 0, front = 0;
  const check = createFocusCheck({ terminal: t, platform: 'darwin', probeHerdr: async () => { herdr++; return 'focused'; }, isTerminalFrontmost: async () => { front++; return true; } });
  tui.handleViewportInput(FOCUS_OUT); assert.equal(await check(), 'unfocused');
  tui.handleViewportInput(FOCUS_IN); assert.equal(await check(), 'focused');
  assert.deepEqual([herdr, front], [0, 0], 'no external probe once an event arrived');
  t.dispose();
});

test('focus check without events: Herdr, then frontmost, then typing, else unknown', async () => {
  const c = clock(); const tui = new FakeTui(); const t = createTerminalFocusTracker(tui, { now: c.now });
  const mk = (herdr: FocusState, front: boolean | undefined, platform = 'darwin') => createFocusCheck({ terminal: t, platform, probeHerdr: async () => herdr, isTerminalFrontmost: async () => front })();
  assert.equal(await mk('unfocused', true), 'unfocused', 'Herdr unfocused');
  assert.equal(await mk('focused', true), 'focused');
  assert.equal(await mk('focused', false), 'unfocused', 'frontmost still refines a focused Herdr on macOS');
  assert.equal(await mk('unknown', true), 'unknown', 'no Herdr and no typing: today\'s behavior');
  tui.handleViewportInput('k');
  assert.equal(await mk('unknown', undefined, 'linux'), 'focused', 'typing implies focus when nothing else knows');
  assert.equal(await mk('unfocused', true), 'unfocused', 'a known Herdr answer beats typing');
  c.advance(61_000); assert.equal(await mk('unknown', undefined, 'linux'), 'unknown');
  t.dispose();
});

test('non-macOS: a known Herdr answer is used without the frontmost check (L91)', async () => {
  let front = 0; const mk = (herdr: FocusState, platform: string) => createFocusCheck({ platform, probeHerdr: async () => herdr, isTerminalFrontmost: async () => { front++; return undefined; } })();
  assert.equal(await mk('focused', 'linux'), 'focused'); assert.equal(await mk('focused', 'win32'), 'focused');
  assert.equal(await mk('unfocused', 'linux'), 'unfocused'); assert.equal(await mk('unknown', 'linux'), 'unknown');
  assert.equal(await mk('focused', 'darwin'), 'unknown', 'macOS still needs the frontmost answer');
});

test('deferral: wake() delivers the pending item without a poll, once, and only while something is pending', async () => {
  let focus: FocusState = 'unfocused'; let checks = 0; const got: Array<[string, unknown]> = [];
  const d = createLatestOnlyDeferral<string>({ checkFocus: async () => { checks++; return focus; }, pollMs: 1_000_000, onReady: (item, o) => got.push([item, o]) });
  await d.offer('a'); assert.deepEqual(got, []);
  await d.wake(); assert.deepEqual(got, [], 'still unfocused');
  focus = 'focused'; await d.wake(); assert.deepEqual(got, [['a', undefined]]);
  const n = checks; await d.wake(); assert.equal(checks, n, 'nothing pending: no check'); assert.equal(got.length, 1);
  await d.offer('b'); d.clear(); focus = 'focused'; await d.wake(); assert.equal(got.length, 2, 'b was delivered on offer (focused), clear() has nothing left');
  d.dispose();
});

// ---- T49 hardening --------------------------------------------------------------------------------------------------------------------

test('T49 R1-typing-focus-spoof: paste brackets and terminal replies (DA, CPR, OSC, DCS, kitty, window size, mode report) never imply focus', () => {
  const replies = ['\x1b[200~pasted\x1b[201~', '\x1b[200~', '\x1b[201~', '\x1b[?62;4c', '\x1b[>0;276;0c', '\x1b[24;80R', '\x1b[?0u', '\x1b[8;40;120t', '\x1b[?2004;1$y',
    '\x1b]11;rgb:0000/0000/0000\x07', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1bP>|kitty(0.30)\x1b\\', '\x1b_Gi=1;OK\x1b\\'];
  for (const reply of replies) {
    const c = clock(); const tui = new FakeTui(); const t = createTerminalFocusTracker(tui, { now: c.now });
    assert.equal(tui.handleViewportInput(reply), RESULT, 'still delegated'); assert.equal(t.state(), 'unknown', `no events: ${JSON.stringify(reply)}`);
    tui.handleViewportInput(FOCUS_OUT); tui.handleViewportInput(reply); assert.equal(t.state(), 'unfocused', `after focus-out: ${JSON.stringify(reply)}`);
    t.dispose();
  }
});

test('T49 R1-typing-focus-spoof: keys, arrows, kitty keys and SGR mouse input still imply focus', () => {
  for (const input of ['a', ' ', '\r', '\x1b', '\x1b[A', '\x1bb', '\x1b[97;1u', '\x1b[1;5C', '\x1b[<0;5;5M', '\x1b[<0;5;5m', 'é']) {
    const tui = new FakeTui(); const t = createTerminalFocusTracker(tui);
    tui.handleViewportInput(FOCUS_OUT); tui.handleViewportInput(input); assert.equal(t.state(), 'focused', JSON.stringify(input));
    t.dispose();
  }
});

test('T49 R1-private-method-wrap: a delegation failure propagates unchanged (input is never swallowed) and the focus event was still observed', () => {
  class Throwing extends FakeTui { handleViewportInput(...args: unknown[]): unknown { void args; throw new Error('pi-tui broke'); } }
  const tui = new Throwing(); const t = createTerminalFocusTracker(tui);
  assert.throws(() => tui.handleViewportInput(FOCUS_OUT), /pi-tui broke/); assert.equal(t.state(), 'unfocused');
  t.dispose();
});

test('T49 R1-private-method-wrap: an observer that throws (clock failure) never breaks or alters input handling', () => {
  const tui = new FakeTui(); const t = createTerminalFocusTracker(tui, { now: () => { throw new Error('clock'); } });
  assert.equal(tui.handleViewportInput('x'), RESULT); assert.equal(tui.calls.length, 1);
  t.dispose();
});

test('T49 R1-private-method-wrap: when the assignment does not stick (setter ignores it) the tracker is not attached and reports unknown', () => {
  const tui = new FakeTui(); const fixed = FakeTui.prototype.handleViewportInput;
  Object.defineProperty(tui, 'handleViewportInput', { get: () => fixed, set() { /* ignored */ }, configurable: true });
  const logs: string[] = [];
  const t = createTerminalFocusTracker(tui, { log: m => logs.push(m) });
  assert.equal(t.attached, false); assert.equal(t.state(), 'unknown'); assert.equal(t.hasEvents(), false);
  assert.equal(logs.length, 1); t.dispose();
});

test('T49 R1-private-method-wrap: dispose never restores over a method that is not our wrapper', () => {
  const tui = new FakeTui(); const t = createTerminalFocusTracker(tui);
  const theirs = function () { return 'theirs'; }; (tui as any).handleViewportInput = theirs;
  t.dispose(); assert.equal((tui as any).handleViewportInput, theirs);
});

test('T49 R3-rerun-unhandled: an onReady that throws during a wake re-run or a poll tick is not an unhandled rejection', async () => {
  const rejections: unknown[] = []; const on = (e: unknown) => { rejections.push(e); }; process.on('unhandledRejection', on);
  try {
    let release!: () => void; let focus: FocusState = 'unfocused'; let gate: Promise<void> | undefined;
    const d = createLatestOnlyDeferral<string>({
      checkFocus: async () => { const seen = focus; if (gate) await gate; return seen; }, pollMs: 1_000_000,
      onReady: () => { throw new Error('speak failed'); },
    });
    await d.offer('a');
    gate = new Promise<void>(r => { release = r; });
    const first = d.wake(); // sees unfocused, parked on the gate
    focus = 'focused'; const second = d.wake(); // busy: schedules a re-run that will see focused and call onReady
    release(); await first; await second;
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    d.dispose();
    const p = createLatestOnlyDeferral<string>({ checkFocus: async () => 'unfocused', pollMs: 5, onReady: () => { throw new Error('boom'); } });
    await p.offer('x'); await new Promise(r => setTimeout(r, 30)); p.dispose();
    assert.deepEqual(rejections, []);
  } finally { process.off('unhandledRejection', on); }
});
