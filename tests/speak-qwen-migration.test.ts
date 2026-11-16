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
import { NO_UNIX_SOCKETS, UNIX_SOCKETS } from './helpers/platform.ts';
import { assertMode } from './helpers/platform.ts';
// T45 / S15: no bundled Qwen voices. The public catalog has none; an existing install is converted once into custom voices; old `qwen-<name>` settings
// keep loading; custom voices need only a Python record (not the old manifest). All fakes; scratch lives under mkdtemp and is removed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import * as voicesModule from '../lib/speak-voices.ts';
import { QWEN_MODEL_ID, VOICE_CATALOG } from '../lib/speak-voices.ts';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, parseSpeakSettingsFile, readSpeakSettings } from '../lib/speak-settings.ts';
import { LEGACY_QWEN_VOICES, MIGRATION_MARKER_FILE, PYTHON_RECORD_FILE, QWEN_VOICES_SCHEMA, migrateLegacyQwenVoices, resolveQwenPython } from '../lib/speak-voices-install.ts';
import { listCustomVoices } from '../lib/speak-custom-voices.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';
import { makeWav, sha256, writeEntry } from './helpers/custom-voice-fixture.ts';

const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const until = async (cond: () => boolean, what = 'condition') => { const end = Date.now() + 5000; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 2)); } };
const quiet = (ms = 40) => new Promise(r => setTimeout(r, ms));
const file = (settings: Record<string, unknown>) => JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, ...settings });

// ---- a fake legacy install: small WAVs with a matching migration table, written like the old installer did ----
type Table = Record<string, { name: string; label: string; file: string; transcript: string; sha256: string; bytes: number }>;
function legacyInstall(home: string, names: string[] = ['intima', 'brisa'], { seconds = {} as Record<string, number> } = {}) {
  const dir = join(home, 'voices', 'qwen3');
  mkdirSync(dir, { recursive: true });
  const table: Table = {}, wavs: Record<string, Buffer> = {}, entries: Record<string, unknown> = {};
  names.forEach((name, i) => {
    const wav = makeWav(seconds[name] ?? 4 + i), label = name === 'intima' ? 'Íntima' : name[0].toUpperCase() + name.slice(1);
    wavs[name] = wav;
    table[`qwen-${name}`] = { name, label, file: `${name}.wav`, transcript: `Transcripción de ${label}.`, sha256: sha256(wav), bytes: wav.length };
    writeFileSync(join(dir, `${name}.wav`), wav);
    entries[`qwen-${name}`] = { file: `${name}.wav`, sha256: sha256(wav), bytes: wav.length, transcript: table[`qwen-${name}`].transcript };
  });
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ schema: QWEN_VOICES_SCHEMA, python: '/fake/python3', model: QWEN_MODEL_ID, voices: entries }, null, 2)}\n`);
  return { dir, table, wavs };
}
function world(names?: string[], opts?: Parameters<typeof legacyInstall>[2]) {
  const root = mkdtempSync(join(tmpdir(), 'speak-migrate-')); roots.push(root);
  const home = join(root, '.gentle-speak'), dotDir = join(root, 'dot-home', '.gentle-speak');
  mkdirSync(home, { recursive: true });
  const legacy = legacyInstall(home, names, opts);
  return { root, home, dotDir, ...legacy };
}
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[p.slice(dir.length).split(sep).join('/')] = sha256(readFileSync(p)); } }; // T62: '/'-separated keys on every OS
  if (existsSync(dir)) walk(dir);
  return out;
};

// ---- the public catalog ----
test('the public catalog keeps Piper es_MX, es_ES and mac and has no built-in Qwen voice or table', () => {
  assert.deepEqual(Object.keys(VOICE_CATALOG), ['es_MX', 'es_ES', 'mac']);
  assert.deepEqual(Object.values(VOICE_CATALOG).map(v => v.engine), ['piper', 'piper', 'system']);
  assert.equal('QWEN_VOICES' in voicesModule, false);
  for (const id of ['qwen-suave', 'qwen-brisa', 'qwen-coqueta', 'qwen-maestra', 'qwen-intima', 'qwen-serena', 'qwen-viva']) assert.equal(Object.hasOwn(VOICE_CATALOG, id), false, id);
});

test('the migration table holds the 7 old voices with their sha256 and transcripts (recognition only, no WAV is shipped)', () => {
  assert.deepEqual(Object.keys(LEGACY_QWEN_VOICES), ['qwen-suave', 'qwen-brisa', 'qwen-coqueta', 'qwen-maestra', 'qwen-intima', 'qwen-serena', 'qwen-viva']);
  const intima = LEGACY_QWEN_VOICES['qwen-intima'];
  assert.deepEqual([intima.name, intima.label, intima.file, intima.sha256, intima.bytes], ['intima', 'Íntima', 'qwen3-chain-l3.wav', '9a4523fa9358accfb20bafc8c04d42c4b00a0356fe41e18204dce6e4bd27e327', 364844]);
  assert.match(intima.transcript, /^Encontré el problema\./);
  for (const v of Object.values(LEGACY_QWEN_VOICES)) { assert.match(v.sha256, /^[0-9a-f]{64}$/); assert.match(v.name, /^[a-z0-9][a-z0-9-]{0,31}$/); assert.ok(v.transcript.length > 20); }
});

// ---- migration: custom voices ----
test('the migration creates custom:<name> voices with the same label, transcript and sha256, copying the WAV', async () => {
  const w = world();
  const outcome = await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home], table: w.table });
  assert.equal(outcome.status, 'migrated');
  assert.deepEqual(outcome.created.map(c => [c.legacyId, c.id]), [['qwen-intima', 'custom:intima'], ['qwen-brisa', 'custom:brisa']]);
  const { voices, skipped } = await listCustomVoices(w.home);
  assert.deepEqual(skipped, []);
  assert.deepEqual(voices.map(v => [v.id, v.label, v.transcript]), [['custom:brisa', 'Propia · Brisa', 'Transcripción de Brisa.'], ['custom:intima', 'Propia · Íntima', 'Transcripción de Íntima.']]);
  for (const name of ['intima', 'brisa']) {
    const dir = join(w.home, 'voices', 'custom', name);
    assert.deepEqual(readFileSync(join(dir, 'reference.wav')), w.wavs[name], 'the copy is byte-identical');
    const meta = JSON.parse(readFileSync(join(dir, 'voice.json'), 'utf8'));
    assert.equal(meta.sha256, w.table[`qwen-${name}`].sha256); assert.equal(meta.id, name);
  }
  assert.deepEqual(readdirSync(join(w.home, 'voices', 'custom')).filter(n => n.startsWith('.')), [], 'no stage dir left');
});

test('a legacy WAV longer than the 30 s import limit (two of the real ones are) still migrates', async () => {
  const w = world(['maestra'], { seconds: { maestra: 36 } });
  const outcome = await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home], table: w.table });
  assert.deepEqual(outcome.created.map(c => c.id), ['custom:maestra']);
  assert.deepEqual((await listCustomVoices(w.home)).voices.map(v => v.id), ['custom:maestra']);
});

// ---- migration: settings in the terminal and in Dot ----
test('the migration maps voice qwen-<name> to custom:<name> in the terminal and in Dot settings, preserving every other key', async () => {
  const w = world();
  mkdirSync(w.dotDir, { recursive: true });
  const terminal = { enabled: true, mode: 'all', voice: 'qwen-intima', speed: 1.25, macVoice: 'Paulina', macFallback: false, copySpeech: true, dotOffer: 'declined', summaryModel: { provider: 'p', id: 'm' }, qwenIdleMinutes: 7 };
  writeFileSync(join(w.home, 'speak-settings.json'), file(terminal));
  writeFileSync(join(w.dotDir, 'speak-settings.json'), file({ enabled: true, voice: 'qwen-brisa', speed: 0.8 }));
  const before = JSON.parse(readFileSync(join(w.home, 'speak-settings.json'), 'utf8')), beforeDot = JSON.parse(readFileSync(join(w.dotDir, 'speak-settings.json'), 'utf8'));
  const outcome = await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home, w.dotDir], table: w.table });
  assert.deepEqual(outcome.mapped.sort(), [join(w.dotDir, 'speak-settings.json'), join(w.home, 'speak-settings.json')].sort());
  assert.deepEqual(JSON.parse(readFileSync(join(w.home, 'speak-settings.json'), 'utf8')), { ...before, voice: 'custom:intima' });
  assert.deepEqual(JSON.parse(readFileSync(join(w.dotDir, 'speak-settings.json'), 'utf8')), { ...beforeDot, voice: 'custom:brisa' });
  assert.equal(readSpeakSettings(w.home).voice, 'custom:intima'); assert.equal(readSpeakSettings(w.dotDir).voice, 'custom:brisa');
  assertMode(join(w.home, 'speak-settings.json'), 0o600);
  assert.deepEqual(readdirSync(w.dotDir), ['speak-settings.json'], 'atomic write leaves no temp file');
});

test('Dot settings that are absent, malformed or on another voice are not created, rewritten or touched', async () => {
  const w = world();
  writeFileSync(join(w.home, 'speak-settings.json'), file({ voice: 'es_ES' }));
  await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home, w.dotDir], table: w.table });
  assert.equal(existsSync(w.dotDir), false, 'an absent Dot file is never created');
  assert.equal(readFileSync(join(w.home, 'speak-settings.json'), 'utf8'), file({ voice: 'es_ES' }), 'other voices are untouched byte for byte');
  const w2 = world(); mkdirSync(w2.dotDir, { recursive: true }); writeFileSync(join(w2.dotDir, 'speak-settings.json'), '{"voice":"qwen-intima", oops');
  const outcome = await migrateLegacyQwenVoices({ home: w2.home, settingsDirs: [w2.dotDir], table: w2.table });
  assert.equal(readFileSync(join(w2.dotDir, 'speak-settings.json'), 'utf8'), '{"voice":"qwen-intima", oops'); assert.deepEqual(outcome.mapped, []);
});

// ---- idempotent, mismatches, nothing deleted ----
test('the migration is idempotent: it records itself and a second run changes nothing', async () => {
  const w = world();
  writeFileSync(join(w.home, 'speak-settings.json'), file({ voice: 'qwen-brisa' }));
  assert.equal((await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home], table: w.table })).status, 'migrated');
  assert.equal(existsSync(join(w.home, MIGRATION_MARKER_FILE)), true);
  const snapshot = tree(w.home);
  writeFileSync(join(w.home, 'speak-settings.json'), file({ voice: 'qwen-intima' })); // an old setting appearing later is not touched again
  const second = await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home], table: w.table });
  assert.equal(second.status, 'already'); assert.deepEqual(second.created, []); assert.deepEqual(second.mapped, []);
  assert.deepEqual({ ...tree(w.home), '/speak-settings.json': '' }, { ...snapshot, '/speak-settings.json': '' });
  assert.equal(readSpeakSettings(w.home).voice, 'qwen-intima');
});

test('a WAV whose sha256 does not match the table, and a missing WAV, are skipped with a reason; the rest migrates', async () => {
  const w = world(['intima', 'brisa', 'suave']);
  writeFileSync(join(w.dir, 'brisa.wav'), makeWav(9)); // different bytes
  rmSync(join(w.dir, 'suave.wav'));
  writeFileSync(join(w.home, 'speak-settings.json'), file({ voice: 'qwen-brisa' }));
  const outcome = await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home], table: w.table });
  assert.deepEqual(outcome.created.map(c => c.id), ['custom:intima']);
  assert.deepEqual(outcome.skipped.map(s => s.legacyId).sort(), ['qwen-brisa', 'qwen-suave']);
  assert.ok(outcome.skipped.every(s => s.reason.length > 0));
  assert.deepEqual((await listCustomVoices(w.home)).voices.map(v => v.id), ['custom:intima']);
  assert.equal(readSpeakSettings(w.home).voice, 'qwen-brisa', 'a skipped voice keeps its old setting');
  assert.equal(outcome.mapped.length, 0);
});

test('a manifest entry whose sha256 or file disagrees with the table is skipped, and an unknown manifest entry is ignored', async () => {
  const w = world(['intima', 'brisa']);
  const manifest = JSON.parse(readFileSync(join(w.dir, 'manifest.json'), 'utf8'));
  manifest.voices['qwen-brisa'].sha256 = '0'.repeat(64); manifest.voices['qwen-otra'] = { file: 'otra.wav', sha256: '1'.repeat(64), bytes: 1, transcript: 'x' };
  writeFileSync(join(w.dir, 'manifest.json'), JSON.stringify(manifest));
  const outcome = await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [], table: w.table });
  assert.deepEqual(outcome.created.map(c => c.id), ['custom:intima']); assert.deepEqual(outcome.skipped.map(s => s.legacyId), ['qwen-brisa']);
});

test('nothing is deleted: the old manifest and WAVs stay byte for byte', async () => {
  const w = world();
  const before = tree(w.dir);
  await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home], table: w.table });
  assert.deepEqual(tree(w.dir), before);
  assert.deepEqual(readFileSync(join(w.dir, 'intima.wav')), w.wavs.intima);
});

test('no valid manifest means nothing to migrate: no custom voice, no marker, nothing created', async () => {
  const w = world();
  for (const raw of [undefined, '{oops', JSON.stringify({ schema: 'other', python: '/p', voices: {} }), JSON.stringify([])]) {
    if (raw === undefined) rmSync(join(w.dir, 'manifest.json')); else writeFileSync(join(w.dir, 'manifest.json'), raw);
    const outcome = await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home], table: w.table });
    assert.equal(outcome.status, 'none'); assert.deepEqual(outcome.created, []);
    assert.equal(existsSync(join(w.home, MIGRATION_MARKER_FILE)), false); assert.equal(existsSync(join(w.home, 'voices', 'custom')), false);
  }
});

test('an existing custom voice with the same audio is reused; another one with the same id gets a new id', async () => {
  const w = world(['intima', 'brisa']);
  const custom = join(w.home, 'voices', 'custom');
  writeEntry(custom, 'intima', { wav: w.wavs.intima, meta: { label: 'Mi Íntima', transcript: 'Mi propia transcripción.' } });
  writeEntry(custom, 'brisa', { wav: makeWav(8) });
  writeFileSync(join(w.home, 'speak-settings.json'), file({ voice: 'qwen-brisa' }));
  const outcome = await migrateLegacyQwenVoices({ home: w.home, settingsDirs: [w.home], table: w.table });
  assert.deepEqual(outcome.created.map(c => [c.legacyId, c.id]), [['qwen-brisa', 'custom:brisa-2']], 'the same audio under custom:intima is not duplicated');
  assert.equal(readSpeakSettings(w.home).voice, 'custom:brisa-2');
  assert.deepEqual(JSON.parse(readFileSync(join(custom, 'intima', 'voice.json'), 'utf8')).label, 'Mi Íntima', 'an existing entry is never rewritten');
});

// ---- settings compatibility ----
test('a settings file that still says qwen-<name> keeps loading; an unknown qwen-* id is still rejected', () => {
  for (const id of Object.keys(LEGACY_QWEN_VOICES)) assert.equal(parseSpeakSettingsFile(file({ voice: id }))?.voice, id, id);
  assert.equal(parseSpeakSettingsFile(file({ voice: 'qwen-desconocida' })), undefined);
  assert.equal(parseSpeakSettingsFile(file({ voice: 'custom:intima' }))?.voice, 'custom:intima');
});

// ---- the Python record ----
test('the Python comes from python.json, else from the old manifest; malformed or relative records give none', () => {
  const root = mkdtempSync(join(tmpdir(), 'speak-python-')); roots.push(root);
  const record = (python: unknown) => writeFileSync(join(root, PYTHON_RECORD_FILE), JSON.stringify({ schema: 'gentle-speak.python/v1', python }));
  assert.equal(resolveQwenPython(root), undefined);
  mkdirSync(join(root, 'voices', 'qwen3'), { recursive: true });
  writeFileSync(join(root, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ python: '/old/python3' }));
  assert.equal(resolveQwenPython(root), '/old/python3', 'backward compatible with the old manifest');
  record('/new/venv/bin/python3'); assert.equal(resolveQwenPython(root), '/new/venv/bin/python3', 'the record wins');
  record('relative/python3'); assert.equal(resolveQwenPython(root), '/old/python3', 'an invalid record falls through');
  writeFileSync(join(root, PYTHON_RECORD_FILE), '{oops'); assert.equal(resolveQwenPython(root), '/old/python3');
});

// ---- extension wiring ----
type Opts = { mode?: string; header?: Record<string, unknown>; as?: 'terminal' | 'dot'; settings?: Record<string, unknown>; dotSettings?: Record<string, unknown>; python?: 'record' | 'manifest' | 'none'; custom?: boolean; say?: boolean; legacy?: boolean; names?: string[] };
function harness(o: Opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'speak-migrate-ext-')); roots.push(root);
  const real = join(root, 'real'), home = join(real, '.gentle-speak'), dotAgent = join(real, '.gentle-dot', 'agent'), dotHome = join(real, '.gentle-dot', 'home'), dotDir = join(dotHome, '.gentle-speak');
  mkdirSync(home, { recursive: true }); mkdirSync(dotAgent, { recursive: true });
  const legacy = o.legacy === false ? undefined : legacyInstall(home, o.names ?? ['intima', 'brisa']);
  if (o.python === 'record') writeFileSync(join(home, PYTHON_RECORD_FILE), JSON.stringify({ schema: 'gentle-speak.python/v1', python: '/venv/bin/python3' }));
  if (o.python === 'manifest' && !legacy) { mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true }); writeFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ python: '/fake/python3' })); }
  if (o.custom) writeEntry(join(home, 'voices', 'custom'), 'mia', { wav: makeWav(7), meta: { label: 'Mia', transcript: 'Hola, soy mia.' } });
  writeFileSync(join(home, 'speak-settings.json'), file({ enabled: true, mode: 'all', voice: 'qwen-intima', ...o.settings }));
  if (o.dotSettings) { mkdirSync(dotDir, { recursive: true }); writeFileSync(join(dotDir, 'speak-settings.json'), file(o.dotSettings)); }
  const dot = o.as === 'dot';
  const env = { PI_CODING_AGENT_DIR: dot ? dotAgent : join(real, '.gentle-shell', 'agent'), GENTLE_DOT_AGENT_HOME: dotAgent, GENTLE_DOT_HOME: dotHome };
  const events = new Map<string, Function>(), tools = new Map<string, any>();
  const notes: string[] = [], sayCalls: any[] = [], pythons: any[] = [];
  const fakeChild = () => { const c: any = Object.assign(new EventEmitter(), { writes: [] as any[], stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } }); c.stdin = { write: (l: string) => { c.writes.push(JSON.parse(l)); return true; } }; return c; };
  const ctx: any = { cwd: '/w', mode: o.mode ?? (dot ? 'rpc' : 'tui'), hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => ({ type: 'session', ...o.header }), getBranch: () => [] },
    ui: { setStatus() {}, setWidget() {}, setTitle() {}, input: async () => undefined, notify: (t: string) => notes.push(t), confirm: async () => false, select: async () => undefined } };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool: (t: any) => tools.set(t.name, t) } as any, undefined, {
    userHome: real, processHome: dot ? dotHome : real, setupOffer: false, env, platform: 'darwin' /* T62: the Mac fallback notice is the macOS one on every host */, sayAvailable: () => o.say !== false, listMacVoices: async () => [{ name: 'Paulina', locale: 'es_MX' }],
    say: async (req: any) => { sayCalls.push(req); return { ok: true, message: 'Speech completed.' }; },
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn: () => fakeChild(), spawnQwen: () => { const c = fakeChild(); pythons.push(c); return c; },
    focusCheck: async () => 'focused', focusPollMs: 5, lockPollMs: 5, qwenTmpRoot: tmpdir(), resolveTerminal: async () => 'com.term', createWatcher: () => ({ start() {}, stop() {} }),
    legacyQwenVoices: legacy?.table,
  } as any);
  const start = () => events.get('session_start')!({}, ctx);
  return { root, home, dotDir, legacy, events, tools, ctx, notes, sayCalls, pythons, start, shutdown: () => events.get('session_shutdown')!({}, ctx),
    terminal: () => JSON.parse(readFileSync(join(home, 'speak-settings.json'), 'utf8')), dot: () => JSON.parse(readFileSync(join(dotDir, 'speak-settings.json'), 'utf8')),
    migrated: () => existsSync(join(home, MIGRATION_MARKER_FILE)), customDirs: () => existsSync(join(home, 'voices', 'custom')) ? readdirSync(join(home, 'voices', 'custom')).sort() : [] };
}

test('terminal session start migrates once: custom voices, terminal and Dot settings mapped, one notice', async () => {
  const h = harness({ dotSettings: { enabled: true, voice: 'qwen-brisa' } });
  try {
    await h.start();
    assert.deepEqual(h.customDirs(), ['brisa', 'intima']); assert.equal(h.terminal().voice, 'custom:intima'); assert.equal(h.dot().voice, 'custom:brisa'); assert.equal(h.migrated(), true);
    assert.equal(h.notes.filter(n => /voces propias/i.test(n)).length, 1, h.notes.join(' | '));
    h.notes.length = 0; await h.start(); assert.equal(h.notes.filter(n => /voces propias/i.test(n)).length, 0, 'never again');
  } finally { h.shutdown(); }
});

test('Gentle Dot engine session start also migrates (terminal and Dot settings)', async () => {
  const h = harness({ as: 'dot', dotSettings: { enabled: true, voice: 'qwen-brisa' } });
  try { await h.start(); assert.deepEqual(h.customDirs(), ['brisa', 'intima']); assert.equal(h.terminal().voice, 'custom:intima'); assert.equal(h.dot().voice, 'custom:brisa'); } finally { h.shutdown(); }
});

test('child, other-RPC, print and json sessions never migrate', async () => {
  const cases: Opts[] = [{ header: { parentSession: '/p' } }, { mode: 'print' }, { mode: 'json' }, { mode: 'rpc', as: 'terminal' }, { as: 'dot', header: { parentSession: '/p' } }];
  for (const c of cases) {
    const h = harness(c);
    try { await h.start(); assert.equal(h.migrated(), false, JSON.stringify(c)); assert.deepEqual(h.customDirs(), []); assert.equal(h.terminal().voice, 'qwen-intima'); } finally { h.shutdown(); }
  }
});

test('an old qwen-<name> setting with no migrated voice loads and falls back like a missing voice, suggesting «Crear voz propia…»', async () => {
  const h = harness({ legacy: false, python: 'manifest' });
  try {
    await h.start();
    assert.equal(readSpeakSettings(h.home).voice, 'qwen-intima', 'the file still loads');
    const out = await h.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, h.ctx);
    assert.deepEqual(h.sayCalls.map(c => c.text), ['Hola.'], 'the Mac fallback speaks');
    assert.equal(h.pythons.length, 0, 'no Qwen worker is started');
    assert.ok(h.notes.some(n => /Crear voz propia…/.test(n) && /Mac voice/.test(n)), h.notes.join(' | '));
    const h2 = harness({ legacy: false, python: 'manifest', say: false });
    try { await h2.start(); const out2 = await h2.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, h2.ctx); assert.equal(out2.isError, true); assert.match(out2.content[0].text, /Crear voz propia…/); assert.ok(h2.notes.some(n => /Crear voz propia…/.test(n))); } finally { h2.shutdown(); }
  } finally { h.shutdown(); }
});

test('a custom voice speaks with only the Python record: no voices/qwen3 manifest is needed', async () => {
  const h = harness({ legacy: false, python: 'record', custom: true, settings: { voice: 'custom:mia' }, say: false });
  try {
    assert.equal(existsSync(join(h.home, 'voices', 'qwen3')), false);
    await h.start();
    const run = h.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, h.ctx);
    await until(() => h.pythons.length === 1, 'worker');
    h.pythons[0].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak.qwen/v1', type: 'ready' }) + '\n');
    await until(() => h.pythons[0].writes.length === 1, 'synth request');
    assert.equal(h.pythons[0].writes[0].ref, join(h.home, 'voices', 'custom', 'mia', 'reference.wav')); assert.equal(h.pythons[0].writes[0].refText, 'Hola, soy mia.');
    h.shutdown(); await run;
  } finally { h.shutdown(); }
});

test('a custom voice with neither a Python record nor a manifest is not usable and says why', async () => {
  const h = harness({ legacy: false, python: 'none', custom: true, settings: { voice: 'custom:mia' }, say: false });
  try {
    await h.start();
    const out = await h.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, h.ctx);
    assert.equal(out.isError, true); assert.equal(h.pythons.length, 0);
  } finally { h.shutdown(); }
});

// ---- preserve: Piper, Mac, custom voices and Dot keep working while a migration runs ----
test('PRESERVE: settings on Piper, mac or a custom voice are never rewritten by the migration', async () => {
  for (const voice of ['es_MX', 'es_ES', 'mac', 'custom:mia']) {
    const h = harness({ settings: { voice }, dotSettings: { enabled: true, voice }, custom: true });
    try {
      const before = [readFileSync(join(h.home, 'speak-settings.json'), 'utf8'), readFileSync(join(h.dotDir, 'speak-settings.json'), 'utf8')];
      await h.start();
      assert.equal(h.migrated(), true, 'the legacy voices still migrate');
      assert.deepEqual([readFileSync(join(h.home, 'speak-settings.json'), 'utf8'), readFileSync(join(h.dotDir, 'speak-settings.json'), 'utf8')], before, voice);
      assert.deepEqual(h.customDirs(), ['brisa', 'intima', 'mia'], 'the user\'s own voice stays next to the migrated ones');
    } finally { h.shutdown(); }
  }
});

test('PRESERVE: the Mac voice speaks in the terminal and, with the Dot prefix, in Gentle Dot after a migration', async () => {
  const term = harness({ settings: { voice: 'mac' } });
  try { await term.start(); await term.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, term.ctx); assert.deepEqual(term.sayCalls.map(c => c.text), ['Hola.']); } finally { term.shutdown(); }
  const dot = harness({ as: 'dot', settings: { voice: 'mac' }, dotSettings: { enabled: true, mode: 'all', voice: 'mac' } });
  try { await dot.start(); await dot.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, dot.ctx); assert.deepEqual(dot.sayCalls.map(c => c.text), ['Dot: Hola.']); } finally { dot.shutdown(); }
});

// ---- the service ----
test('the shared service validates refs under voices/custom only: voices/qwen3 is no longer accepted', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const { qwenFixture, rawClient } = await import('./helpers/qwen-service-fixture.ts');
  const { connectQwenService } = await import('../lib/speak-qwen-service.ts');
  const fx = qwenFixture();
  try {
    const custom = join(fx.home, 'voices', 'custom', 'mi-voz');
    mkdirSync(custom, { recursive: true }); writeFileSync(join(custom, 'reference.wav'), 'RIFF');
    const connection = await connectQwenService(fx.options()); connection.socket.setEncoding('utf8');
    const c = rawClient(connection.socket, connection.rest);
    const send = (id: number, ref: string) => c.send({ type: 'synth', id, priority: 'speak', text: 'hola', ref, refText: 'ref', outDir: fx.outDir(), speed: 1 });
    send(1, join(custom, 'reference.wav'));
    await c.waitFor(m => m.some(x => x.id === 1 && x.type === 'done'), 'custom ref accepted');
    mkdirSync(join(fx.home, 'voices', 'qwen3'), { recursive: true }); writeFileSync(join(fx.home, 'voices', 'qwen3', 'ref.wav'), 'RIFF');
    send(2, join(fx.home, 'voices', 'qwen3', 'ref.wav'));
    await c.waitFor(m => m.some(x => x.id === 2 && x.type === 'error'), 'qwen3 ref rejected');
    assert.match(c.ofId(2)[0].message, /^invalid request: bad ref/);
  } finally { await fx.close(); }
});
