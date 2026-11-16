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
import { EXEC_BIT } from './helpers/platform.ts';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFocusCheck, createLatestOnlyDeferral, probeHerdrFocus, projectPrefix, readFrontmostBundleId } from '../lib/speak-focus.ts';

const herdrEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'w4:p1' };
const reply = (focused: unknown) => async () => JSON.stringify({ result: { pane: { focused, id: 'w4:p1' } } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('probe: focused true/false map to focused/unfocused and run `herdr pane get <id>`', async () => {
  const calls: any[] = [];
  const exec = async (file: string, args: string[], opts: { timeoutMs: number }) => { calls.push({ file, args, opts }); return reply(true)(); };
  assert.equal(await probeHerdrFocus({ env: herdrEnv, exec, timeoutMs: 700 }), 'focused');
  assert.deepEqual(calls[0], { file: 'herdr', args: ['pane', 'get', 'w4:p1'], opts: { timeoutMs: 700 } });
  assert.equal(await probeHerdrFocus({ env: herdrEnv, exec: reply(false), timeoutMs: 700 }), 'unfocused');
});

/** A scratch dir with files whose names and modes the herdr binary validation cares about. */
function binFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'speak-herdr-bin-'));
  const make = (rel: string, mode: number) => { const f = join(dir, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, '#!/bin/sh\n'); chmodSync(f, mode); return f; };
  return { dir, make, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const runBin = async (bin: string | undefined) => { let file = ''; await probeHerdrFocus({ env: { ...herdrEnv, ...(bin === undefined ? {} : { HERDR_BIN_PATH: bin }) }, exec: async f => { file = f; return reply(true)(); }, timeoutMs: 1 }); return file; };

test('probe: HERDR_BIN_PATH replaces the herdr binary when it is an executable regular file', async () => {
  const fx = binFixture();
  try {
    const good = fx.make('herdr', 0o755);
    assert.equal(await runBin(good), good);
  } finally { fx.done(); }
});

test('probe: HERDR_BIN_PATH is executed only when absolute with basename herdr; otherwise PATH herdr', async () => {
  const fx = binFixture();
  try {
    const good = fx.make('bin/herdr', 0o755);
    assert.equal(await runBin(good), good);
    for (const bad of ['/tmp/evil', '/opt/herdr/../sh', 'herdr-x', './herdr', 'bin/herdr', '/opt/notherdr', '']) assert.equal(await runBin(bad), 'herdr', bad);
    assert.equal(await runBin(undefined), 'herdr');
  } finally { fx.done(); }
});

test('probe: HERDR_BIN_PATH that does not exist, is not executable or is not a regular file falls back to PATH herdr', async () => {
  const fx = binFixture();
  try {
    assert.equal(await runBin(join(fx.dir, 'missing', 'herdr')), 'herdr', 'missing');
    if (EXEC_BIT) assert.equal(await runBin(fx.make('noexec/herdr', 0o644)), 'herdr', 'not executable'); // T62: NO_EXEC_BIT on Windows
    mkdirSync(join(fx.dir, 'dir', 'herdr'), { recursive: true });
    assert.equal(await runBin(join(fx.dir, 'dir', 'herdr')), 'herdr', 'directory');
    const target = fx.make('real/tool', 0o755);
    mkdirSync(join(fx.dir, 'link'));
    symlinkSync(target, join(fx.dir, 'link', 'herdr'));
    assert.equal(await runBin(join(fx.dir, 'link', 'herdr')), join(fx.dir, 'link', 'herdr'), 'symlink to an executable file is a regular executable');
  } finally { fx.done(); }
});

test('readFrontmostBundleId runs one JXA osascript without System Events and trims the bundle id', async () => {
  const calls: any[] = [];
  const exec = async (file: string, args: string[], opts: any) => { calls.push({ file, args, opts }); return 'com.github.wez.wezterm\n'; };
  assert.equal(await readFrontmostBundleId({ exec, timeoutMs: 900 }), 'com.github.wez.wezterm');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'osascript');
  assert.deepEqual(calls[0].args.slice(0, 2), ['-l', 'JavaScript']);
  assert.match(calls[0].args.join(' '), /NSWorkspace\.sharedWorkspace\.frontmostApplication\.bundleIdentifier/);
  assert.doesNotMatch(calls[0].args.join(' '), /System Events/);
  assert.deepEqual(calls[0].opts, { timeoutMs: 900 });
  assert.equal(await readFrontmostBundleId({ exec: async () => '\n', timeoutMs: 1 }), undefined);
  assert.equal(await readFrontmostBundleId({ exec: async () => { throw new Error('x'); }, timeoutMs: 1 }), undefined);
  assert.equal(await readFrontmostBundleId({ exec: () => new Promise(() => {}), timeoutMs: 20 }), undefined);
});

test('probe: unknown without Herdr env, without pane id, and never execs', async () => {
  let ran = 0;
  const exec = async () => { ran++; return reply(true)(); };
  assert.equal(await probeHerdrFocus({ env: {}, exec, timeoutMs: 1 }), 'unknown');
  assert.equal(await probeHerdrFocus({ env: { HERDR_ENV: '0', HERDR_PANE_ID: 'x' }, exec, timeoutMs: 1 }), 'unknown');
  assert.equal(await probeHerdrFocus({ env: { HERDR_ENV: '1' }, exec, timeoutMs: 1 }), 'unknown');
  assert.equal(ran, 0);
});

test('probe: unknown on exec error, timeout, bad JSON and unexpected shape', async () => {
  const p = (exec: any) => probeHerdrFocus({ env: herdrEnv, exec, timeoutMs: 20 });
  assert.equal(await p(async () => { throw new Error('boom'); }), 'unknown');
  assert.equal(await p(() => new Promise(() => {})), 'unknown');
  assert.equal(await p(async () => 'not json'), 'unknown');
  assert.equal(await p(async () => '{"result":{}}'), 'unknown');
  assert.equal(await p(reply('yes')), 'unknown');
  assert.equal(await p(async () => 'null'), 'unknown');
});

test('focus check: focused only when terminal frontmost and Herdr focused; unknown follows Herdr', async () => {
  const mk = (herdr: any, front: boolean | Error) => createFocusCheck({
    probeHerdr: async () => herdr,
    isTerminalFrontmost: async () => { if (front instanceof Error) throw front; return front; },
  })();
  assert.equal(await mk('focused', true), 'focused');
  assert.equal(await mk('focused', false), 'unfocused');
  assert.equal(await mk('unfocused', true), 'unfocused');
  assert.equal(await mk('unknown', true), 'unknown');
  assert.equal(await mk('unknown', false), 'unknown');
  assert.equal(await mk('focused', new Error('x')), 'unknown');
  assert.equal(await mk('focused', undefined as any), 'unknown');
  assert.equal(await mk('unfocused', undefined as any), 'unfocused');
});

test('focus check: both probes start at once, before either settles', async () => {
  const started: string[] = [];
  const never = new Promise<never>(() => {});
  const check = createFocusCheck({
    timeoutMs: 5,
    probeHerdr: () => { started.push('herdr'); return never; },
    isTerminalFrontmost: () => { started.push('front'); return never; },
  })();
  assert.deepEqual(started, ['herdr', 'front']);
  assert.equal(await check, 'unknown');
});

test('focus check: a probe that never settles times out to unknown; a prompt unfocused still wins', async () => {
  const never = new Promise<never>(() => {});
  const mk = (herdr: any, front: any) => createFocusCheck({ timeoutMs: 5, probeHerdr: () => herdr, isTerminalFrontmost: () => front })();
  assert.equal(await mk(never, Promise.resolve(true)), 'unknown', 'herdr hangs');
  assert.equal(await mk(Promise.resolve('focused'), never), 'unknown', 'osascript hangs');
  assert.equal(await mk(Promise.resolve('unfocused'), never), 'unfocused', 'unfocused is decided by herdr alone');
  assert.equal(await mk(Promise.resolve('focused'), Promise.resolve(true)), 'focused');
  assert.equal(await mk(Promise.resolve('focused'), Promise.reject(new Error('x'))), 'unknown');
});

test('projectPrefix uses the cwd basename', () => {
  assert.equal(projectPrefix('/home/u/gentle-theme', 'hola'), 'gentle-theme: hola');
  assert.equal(projectPrefix('/home/u/gentle-theme/', 'hola'), 'gentle-theme: hola');
});

function harness(initial: 'focused' | 'unfocused' | 'unknown') {
  const state = { focus: initial };
  const delivered: any[] = [];
  const d = createLatestOnlyDeferral<string>({
    checkFocus: async () => state.focus,
    pollMs: 5,
    onReady: (item, o) => { delivered.push([item, o?.prefixProject === true]); },
  });
  return { state, delivered, d };
}

test('deferral: focused speaks now, unknown speaks now with prefixProject', async () => {
  const f = harness('focused');
  await f.d.offer('a');
  assert.deepEqual(f.delivered, [['a', false]]);
  const u = harness('unknown');
  await u.d.offer('b');
  assert.deepEqual(u.delivered, [['b', true]]);
  f.d.dispose(); u.d.dispose();
});

test('deferral: unfocused keeps only the latest and delivers once when focus arrives', async () => {
  const h = harness('unfocused');
  await h.d.offer('one');
  await h.d.offer('two');
  await h.d.offer('three');
  await sleep(30);
  assert.deepEqual(h.delivered, []);
  h.state.focus = 'focused';
  await sleep(40);
  assert.deepEqual(h.delivered, [['three', false]]);
  await sleep(30);
  assert.equal(h.delivered.length, 1);
  h.d.dispose();
});

test('deferral: pending item delivered with prefix if focus becomes unknown', async () => {
  const h = harness('unfocused');
  await h.d.offer('x');
  h.state.focus = 'unknown';
  await sleep(40);
  assert.deepEqual(h.delivered, [['x', true]]);
  h.d.dispose();
});

test('deferral: clear drops the pending item and stops polling, new offers still work', async () => {
  const h = harness('unfocused');
  await h.d.offer('x');
  h.d.clear();
  h.state.focus = 'focused';
  await sleep(30);
  assert.deepEqual(h.delivered, []);
  await h.d.offer('y');
  assert.deepEqual(h.delivered, [['y', false]]);
  h.d.dispose();
});

test('deferral: dispose is permanent', async () => {
  const h = harness('unfocused');
  await h.d.offer('x');
  h.d.dispose();
  h.state.focus = 'focused';
  await sleep(30);
  await h.d.offer('z');
  assert.deepEqual(h.delivered, []);
});

test('deferral: a newer offer replaces an item whose focus check is in flight', async () => {
  let release: (v: 'focused') => void = () => {};
  let first = true;
  const delivered: string[] = [];
  const d = createLatestOnlyDeferral<string>({
    checkFocus: () => first ? ((first = false), new Promise(r => { release = r as any; })) : Promise.resolve('unfocused'),
    pollMs: 5,
    onReady: item => { delivered.push(item); },
  });
  const p = d.offer('old');
  const q = d.offer('new');
  release('focused');
  await Promise.all([p, q]);
  await sleep(20);
  assert.deepEqual(delivered, []); // 'old' was replaced before its check resolved; 'new' is still unfocused
  d.dispose();
});

test('deferral: checkFocus failure counts as unknown', async () => {
  const delivered: any[] = [];
  const d = createLatestOnlyDeferral<string>({
    checkFocus: async () => { throw new Error('x'); }, pollMs: 5,
    onReady: (i, o) => { delivered.push([i, o?.prefixProject === true]); },
  });
  await d.offer('a');
  assert.deepEqual(delivered, [['a', true]]);
  d.dispose();
});
