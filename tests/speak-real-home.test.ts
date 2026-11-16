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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import { realHome } from '../lib/speak-home.ts';
import { dotAgentHome, isDotEngine, sessionAgentDir, terminalSource } from '../lib/speak-dot.ts';
import { spawnQwenPython } from '../lib/speak-qwen.ts';
import { QWEN_PYTHON_FLAGS } from '../lib/speak-voices.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';

// T33 (S12): inside Gentle Dot's engine $HOME is overridden, so user-level paths come from the account's real home. Pure/injected; scratch under mktemp.
const roots: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'speak-real-home-')); roots.push(d); return d; };
const savedHome = process.env.HOME;
test.afterEach(() => { process.env.HOME = savedHome; for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

test('realHome: the account home (userInfo) wins over $HOME; falls back to homedir() when it is empty, relative or unavailable', () => {
  assert.equal(realHome({ userInfo: () => ({ homedir: '/real/user' }), homedir: () => '/fake/home' }), '/real/user');
  assert.equal(realHome({ userInfo: () => ({ homedir: '' }), homedir: () => '/fake/home' }), '/fake/home');
  assert.equal(realHome({ userInfo: () => ({ homedir: 'relative/dir' }), homedir: () => '/fake/home' }), '/fake/home');
  assert.equal(realHome({ userInfo: () => { throw new Error('no passwd entry'); }, homedir: () => '/fake/home' }), '/fake/home');
});

test('real home from the process: with HOME overridden, library defaults still use the account home', () => {
  const real = userInfo().homedir;
  process.env.HOME = '/tmp/fake-home-t33';
  assert.equal(realHome(), real);
  assert.equal(dotAgentHome({ env: {} }), join(real, '.gentle-dot', 'agent'));
  assert.equal(sessionAgentDir({ env: {} }), join(real, '.pi', 'agent'));
  assert.equal(isDotEngine({ env: { PI_CODING_AGENT_DIR: join(real, '.gentle-dot', 'agent') } }), true);
  assert.equal(dotAgentHome({ env: { GENTLE_DOT_AGENT_HOME: '/explicit/dot' } }), resolve('/explicit/dot'), 'explicit env keeps its priority');
  assert.equal(dotAgentHome({ env: {}, home: '/injected' }), resolve('/injected/.gentle-dot/agent'), 'explicit injection keeps its priority');
});

test('connect expands `~` against the real home, not $HOME', () => {
  const real = userInfo().homedir, dir = scratch();
  process.env.HOME = '/tmp/fake-home-t33';
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ packages: ['~/dev/gentle-speak'] }));
  assert.equal(terminalSource({ env: { PI_CODING_AGENT_DIR: dir }, packageRoot: '/pkg' }), join(real, 'dev', 'gentle-speak'));
});

test('Python worker env: HOME is the real home (user site-packages), flags and other env are kept', () => {
  const calls: Array<{ file: string; args: string[]; options: any }> = [];
  const fake = ((file: string, args: string[], options: any) => { calls.push({ file, args, options }); return new EventEmitter(); }) as any;
  spawnQwenPython('/py/python3', '/s/worker.py', { spawn: fake, env: { HOME: '/fake/home', PATH: '/bin', KEEP: '1' }, home: '/real/user' });
  assert.equal(calls[0].file, '/py/python3');
  assert.deepEqual(calls[0].args, [...QWEN_PYTHON_FLAGS, '/s/worker.py']); assert.ok(calls[0].args.includes('-E') && calls[0].args.includes('-P'));
  assert.deepEqual(calls[0].options.env, { HOME: '/real/user', PATH: '/bin', KEEP: '1', HF_HOME: join('/real/user', '.cache', 'huggingface'), HF_HUB_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' });
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

// L72: Gentle Dot sets XDG_CACHE_HOME under its own home; without HF_HOME, huggingface_hub looked there and missed the model cache.
test('Python worker env: HF_HOME pins the real Hugging Face cache even when XDG_CACHE_HOME points elsewhere', () => {
  const calls: Array<{ options: any }> = [];
  const fake = ((_file: string, _args: string[], options: any) => { calls.push({ options }); return new EventEmitter(); }) as any;
  spawnQwenPython('/py/python3', '/s/worker.py', { spawn: fake, env: { HOME: '/dot/home', XDG_CACHE_HOME: '/dot/home/.cache' }, home: '/real/user' });
  assert.equal(calls[0].options.env.HF_HOME, join('/real/user', '.cache', 'huggingface'));
  assert.equal(calls[0].options.env.XDG_CACHE_HOME, '/dot/home/.cache');
});

test('Python worker env: a user-set HF_HOME is kept', () => {
  const calls: Array<{ options: any }> = [];
  const fake = ((_file: string, _args: string[], options: any) => { calls.push({ options }); return new EventEmitter(); }) as any;
  spawnQwenPython('/py/python3', '/s/worker.py', { spawn: fake, env: { HF_HOME: '/custom/hf', XDG_CACHE_HOME: '/dot/home/.cache' }, home: '/real/user' });
  assert.equal(calls[0].options.env.HF_HOME, '/custom/hf');
});

function dotRpc(real: string, fakeHome: string) {
  const speakHome = join(real, '.gentle-speak'), dotAgent = join(real, '.gentle-dot', 'agent');
  mkdirSync(speakHome, { recursive: true }); mkdirSync(dotAgent, { recursive: true });
  writeFileSync(join(speakHome, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: false, mode: 'all', dotSpeech: true }));
  // T34: Dot reads its OWN settings from its $HOME; the terminal file in the real home is ignored.
  mkdirSync(join(fakeHome, '.gentle-speak'), { recursive: true });
  writeFileSync(join(fakeHome, '.gentle-speak', 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all' }));
  const events = new Map<string, Function>(), writes: string[] = [];
  const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } });
  child.stdin = { write: (l: string) => { writes.push(l); return true; } };
  const ctx: any = { cwd: '/w', mode: 'rpc', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Listo.' }] } }] },
    ui: { notify() {}, setStatus() {}, setWidget() {}, confirm: async () => false, select: async () => undefined } };
  process.env.HOME = fakeHome;
  // No explicit speak home: it must derive from the real home. Only the account home is injected (as userInfo().homedir would be).
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool() {} } as any, undefined, {
    userHome: real, processHome: fakeHome, env: { PI_CODING_AGENT_DIR: dotAgent, HOME: fakeHome }, spawn: () => child, modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }),
    focusCheck: async () => 'unfocused', focusPollMs: 5, lockPollMs: 5, sayAvailable: () => false, resolveTerminal: async () => undefined,
  } as any);
  return { events, ctx, writes, child };
}

test('inside Dot (HOME overridden): settings come from its own $HOME/.gentle-speak (the terminal one is ignored), the session is recognized as Dot and speaks `Dot: `', async () => {
  const real = scratch(), fakeHome = join(scratch(), 'fake-home');
  const w = dotRpc(real, fakeHome);
  const turn = w.events.get('agent_settled')!({ aborted: false }, w.ctx);
  const deadline = Date.now() + 5000; while (!w.writes.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 1));
  assert.equal(JSON.parse(w.writes[0]).text, 'Dot: Listo.');
  w.child.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: JSON.parse(w.writes[0]).id }) + '\n'); await turn;
  w.events.get('session_shutdown')!({}, w.ctx);
});

test('preserve (terminal): when HOME is the real home, the default speak home is <home>/.gentle-speak and nothing else changes', () => {
  const real = scratch();
  assert.equal(realHome({ userInfo: () => ({ homedir: real }), homedir: () => real }), real);
  assert.equal(dotAgentHome({ env: {}, home: real }), join(real, '.gentle-dot', 'agent'));
  assert.equal(isDotEngine({ env: { PI_CODING_AGENT_DIR: join(real, '.gentle-shell', 'agent') }, home: real }), false);
});
