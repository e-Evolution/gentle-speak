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
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { backupDotSettings, connectDot, detectDot, disconnectDot, dotAgentHome, isConnected, isDotEngine, isSpeakEntry, sessionAgentDir, terminalSource } from '../lib/speak-dot.ts';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, parseSpeakSettingsFile, readSpeakSettings } from '../lib/speak-settings.ts';

// S12 library: Dot's engine home, settings.json packages, connect/disconnect. Every path lives in a mktemp -d root.
const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), 'speak-dot-')); roots.push(r); return r; };
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const setup = (dotSettings?: string) => {
  const base = root(), home = join(base, 'home'), dot = join(home, '.gentle-dot', 'agent');
  mkdirSync(dot, { recursive: true });
  if (dotSettings !== undefined) writeFileSync(join(dot, 'settings.json'), dotSettings);
  return { base, home, dot, io: { env: {} as Record<string, string | undefined>, home } };
};
const backups = (dir: string) => readdirSync(dir).filter(name => name.startsWith('settings.json.gentle-speak-backup-'));

test('the Dot engine home is GENTLE_DOT_AGENT_HOME, else ~/.gentle-dot/agent', () => {
  const { home, dot, io } = setup();
  assert.equal(dotAgentHome(io), dot);
  assert.equal(dotAgentHome({ ...io, env: { GENTLE_DOT_AGENT_HOME: '/x/dot/agent' } }), '/x/dot/agent');
  assert.equal(dotAgentHome({ ...io, env: { GENTLE_DOT_AGENT_HOME: '~/other' } }), join(home, 'other'));
});

test('a process is Dot\'s engine when its agent dir equals Dot\'s home, or GENTLE_SPEAK_DOT=1', () => {
  const { dot, home } = setup();
  assert.equal(isDotEngine({ home, env: { PI_CODING_AGENT_DIR: dot } }), true);
  assert.equal(isDotEngine({ home, env: { GENTLE_PI_AGENT_HOME: dot } }), true);
  assert.equal(isDotEngine({ home, env: { PI_CODING_AGENT_DIR: join(home, '.gentle-shell', 'agent') } }), false);
  assert.equal(isDotEngine({ home, env: {} }), false, 'default agent dir is ~/.pi/agent');
  assert.equal(sessionAgentDir({ home, env: {} }), join(home, '.pi', 'agent'));
  assert.equal(isDotEngine({ home, env: { GENTLE_DOT_AGENT_HOME: '/d/agent', PI_CODING_AGENT_DIR: '/d/agent/' } }), true);
  assert.equal(isDotEngine({ home, env: { GENTLE_SPEAK_DOT: '1', PI_CODING_AGENT_DIR: '/elsewhere' } }), true);
  assert.equal(isDotEngine({ home, env: { GENTLE_SPEAK_DOT: '0', PI_CODING_AGENT_DIR: '/elsewhere' } }), false);
});

test('gentle-speak entries are recognised as npm, git, local and object sources, and nothing else', () => {
  for (const entry of ['npm:gentle-speak', 'npm:gentle-speak@0.1.0', '../../Develop/AI/gentle-speak', '/a/b/gentle-speak/', 'git:github.com/x/gentle-speak.git', { source: 'npm:gentle-speak' }]) assert.equal(isSpeakEntry(entry), true, JSON.stringify(entry));
  for (const entry of ['npm:gentle-engram', 'npm:gentle-speak-extra', '/a/gentle-speaker', 'npm:pi-btw', { source: 'npm:pi-btw' }, 7, null]) assert.equal(isSpeakEntry(entry), false, JSON.stringify(entry));
});

test('detect reports absent, malformed, ready and connected', () => {
  const absent = setup();
  assert.equal(detectDot(absent.io).state, 'absent');
  assert.equal(isConnected(absent.io), false);
  for (const raw of ['{', '[]', '"x"', '{"packages":"npm:x"}']) { const s = setup(raw); assert.equal(detectDot(s.io).state, 'malformed', raw); assert.equal(isConnected(s.io), false); }
  const ready = setup('{"packages":["npm:pi-btw"]}');
  assert.deepEqual(detectDot(ready.io), { state: 'ready', path: join(ready.dot, 'settings.json'), connected: false });
  assert.equal(detectDot(setup('{}').io).state, 'ready');
  const connected = setup('{"packages":["npm:pi-btw","npm:gentle-speak"]}');
  assert.equal(isConnected(connected.io), true);
});

test('connect backs up, appends, keeps every other key, writes 2-space JSON with mode 0600 through a rename', () => {
  const original = '{\n  "extensions": ["-builtin:codemode"],\n  "packages": ["npm:pi-btw"],\n  "theme": "x",\n  "nested": { "a": [1, 2] }\n}\n';
  const s = setup(original);
  const renames: string[][] = [];
  const spyFs = { ...fs, renameSync: (a: any, b: any) => { renames.push([String(a), String(b)]); return fs.renameSync(a, b); } } as any;
  const done = connectDot('/pkg/gentle-speak', { ...s.io, fs: spyFs, now: () => new Date('2026-11-10T12:34:56.789Z') });
  assert.ok(done.ok && done.changed);
  const settings = join(s.dot, 'settings.json');
  assert.equal(done.backup, `${settings}.gentle-speak-backup-2026-11-10T12-34-56-789Z`);
  assert.equal(readFileSync(done.backup!, 'utf8'), original, 'the backup is the exact previous file');
  assert.equal(readFileSync(settings, 'utf8'), `${JSON.stringify({ extensions: ['-builtin:codemode'], packages: ['npm:pi-btw', '/pkg/gentle-speak'], theme: 'x', nested: { a: [1, 2] } }, null, 2)}\n`);
  assert.equal(statSync(settings).mode & 0o777, 0o600);
  assert.equal(renames.length, 1);
  assert.match(renames[0][0], /settings\.json\..*\.tmp$/); assert.equal(renames[0][1], settings);
  assert.deepEqual(readdirSync(s.dot).filter(n => n.endsWith('.tmp')), [], 'no temporary file is left');
});

test('connect creates packages when absent, is a no-op when already connected, and never writes a malformed file', () => {
  const s = setup('{"theme":"x"}');
  assert.ok(connectDot('npm:gentle-speak', s.io).ok);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dot, 'settings.json'), 'utf8')), { theme: 'x', packages: ['npm:gentle-speak'] });
  const before = readFileSync(join(s.dot, 'settings.json'), 'utf8'), count = backups(s.dot).length;
  assert.deepEqual(connectDot('npm:gentle-speak', s.io), { ok: true, changed: false });
  assert.equal(readFileSync(join(s.dot, 'settings.json'), 'utf8'), before); assert.equal(backups(s.dot).length, count, 'no backup for a no-op');
  const bad = setup('{"packages": [oops'); 
  assert.deepEqual(connectDot('npm:gentle-speak', bad.io), { ok: false, reason: 'malformed' });
  assert.equal(readFileSync(join(bad.dot, 'settings.json'), 'utf8'), '{"packages": [oops'); assert.deepEqual(backups(bad.dot), []);
  assert.deepEqual(connectDot('npm:gentle-speak', setup().io), { ok: false, reason: 'absent' });
});

test('disconnect backs up and removes only gentle-speak entries; a no-op leaves the file and makes no backup', () => {
  const s = setup(JSON.stringify({ packages: ['npm:pi-btw', '/a/gentle-speak', { source: 'npm:gentle-speak@1' }, 'npm:gentle-engram'], keep: true }));
  const done = disconnectDot(s.io);
  assert.ok(done.ok && done.changed && done.backup);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dot, 'settings.json'), 'utf8')), { packages: ['npm:pi-btw', 'npm:gentle-engram'], keep: true });
  assert.equal(JSON.parse(readFileSync(done.backup!, 'utf8')).packages.length, 4);
  assert.deepEqual(disconnectDot(s.io), { ok: true, changed: false }); assert.equal(backups(s.dot).length, 1);
});

test('backups never overwrite an earlier one taken in the same millisecond', () => {
  const s = setup('{}'); const path = join(s.dot, 'settings.json'), now = () => new Date('2026-01-01T00:00:00.000Z');
  const a = backupDotSettings(path, { ...s.io, now }), b = backupDotSettings(path, { ...s.io, now });
  assert.notEqual(a, b); assert.equal(backups(s.dot).length, 2);
});

test('the terminal source: local paths are re-resolved for Dot (absolute), npm is copied, a missing entry falls back to the package root', () => {
  const base = root(), home = join(base, 'home'), shell = join(base, 'shell', 'agent');
  mkdirSync(shell, { recursive: true });
  const env = { PI_CODING_AGENT_DIR: shell };
  const write = (packages: unknown[]) => writeFileSync(join(shell, 'settings.json'), JSON.stringify({ packages }));
  write(['npm:pi-btw', '../../dev/gentle-speak']);
  assert.equal(terminalSource({ env, home, packageRoot: '/root' }), resolve(shell, '../../dev/gentle-speak'));
  write(['~/dev/gentle-speak']);
  assert.equal(terminalSource({ env, home, packageRoot: '/root' }), join(home, 'dev', 'gentle-speak'), 'the real home, not Dot\'s');
  write(['/abs/gentle-speak']);
  assert.equal(terminalSource({ env, home, packageRoot: '/root' }), '/abs/gentle-speak');
  write(['npm:gentle-speak@0.2.0']);
  assert.equal(terminalSource({ env, home, packageRoot: '/root' }), 'npm:gentle-speak@0.2.0');
  write([{ source: '../x/gentle-speak', extensions: ['a'] }]);
  assert.deepEqual(terminalSource({ env, home, packageRoot: '/root' }), { source: resolve(shell, '../x/gentle-speak'), extensions: ['a'] });
  write(['npm:pi-btw']);
  assert.equal(terminalSource({ env, home, packageRoot: '/root' }), '/root');
  rmSync(join(shell, 'settings.json'));
  assert.equal(terminalSource({ env, home, packageRoot: '/root' }), '/root');
});

test('settings: dotSpeech and dotOffer default off/null, old files still load, malformed values reject the file', () => {
  assert.equal(DEFAULT_SPEAK_SETTINGS.dotSpeech, false); assert.equal(DEFAULT_SPEAK_SETTINGS.dotOffer, null);
  const old = { schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS } as any; delete old.dotSpeech; delete old.dotOffer;
  assert.deepEqual(parseSpeakSettingsFile(JSON.stringify(old)), DEFAULT_SPEAK_SETTINGS);
  const ok = parseSpeakSettingsFile(JSON.stringify({ ...old, dotSpeech: true, dotOffer: 'declined' }));
  assert.equal(ok?.dotSpeech, true); assert.equal(ok?.dotOffer, 'declined');
  assert.equal(parseSpeakSettingsFile(JSON.stringify({ ...old, dotOffer: null }))?.dotOffer, null);
  for (const bad of [{ dotSpeech: 'yes' }, { dotSpeech: 1 }, { dotSpeech: null }, { dotOffer: 'accepted' }, { dotOffer: true }, { dotOffer: '' }]) assert.equal(parseSpeakSettingsFile(JSON.stringify({ ...old, ...bad })), undefined, JSON.stringify(bad));
  const home = root(); writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ ...old, dotSpeech: 'x' }));
  assert.deepEqual(readSpeakSettings(home), DEFAULT_SPEAK_SETTINGS);
});
