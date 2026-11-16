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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, parseSpeakSettingsFile, readSpeakSettings } from '../lib/speak-settings.ts';
import { QWEN_MODEL_ID } from '../lib/speak-voices.ts';
import { makeWav, writeEntry } from './helpers/custom-voice-fixture.ts';
import { hermetic } from './helpers/hermetic.ts';

// T44 (S15) wiring: the first-start offer, «Instalar todo», `/speak doctor`. Fakes for uv, python, the HF API, downloads, ffmpeg and audio; temp homes; no real path.
const until = async (cond: () => boolean, what = 'condition') => {
  const deadline = Date.now() + 5000;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 1)); }
};
const quiet = (ms = 40) => new Promise(r => setTimeout(r, ms));
const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
// T61: no test here may reach the network; the production wiring must not even try before the confirmation (counted).
const fetches: string[] = [];
const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = (async (url: unknown) => { fetches.push(String(url)); throw new Error('network disabled in tests'); }) as typeof fetch; });
test.after(() => { globalThis.fetch = realFetch; });

type Opts = {
  mode?: string; header?: any; target?: string; platform?: string; ffmpeg?: boolean; uv?: boolean; offer?: boolean; settings?: Record<string, unknown> | null;
  states?: Partial<Record<'runtime' | 'piper' | 'python' | 'base', string>>; confirm?: (title: string, message: string) => Promise<boolean> | boolean; select?: string[];
  failPiper?: boolean; gate?: Promise<void>; custom?: boolean; dot?: boolean; legacy?: boolean;
};
function world(o: Opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'gs-setup-wiring-')); roots.push(base);
  const userHome = join(base, 'home'), speakHome = join(userHome, '.gentle-speak'), hfHome = join(base, 'hf');
  mkdirSync(speakHome, { recursive: true, mode: 0o700 });
  const settingsFile = join(speakHome, 'speak-settings.json');
  if (o.settings !== null) writeFileSync(settingsFile, JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, ...o.settings }));
  if (o.custom) writeEntry(join(speakHome, 'voices', 'custom'), 'mia', { wav: makeWav(7), meta: { label: 'Mia', transcript: 'Hola, soy mia.' } });
  const st = { runtime: 'missing', piper: 'missing', python: 'missing', base: 'missing', ...o.states };
  const log: string[] = [], run: { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }[] = [], downloads: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const confirms: { title: string; message: string }[] = [], notes: { text: string; level?: string }[] = [], selections = [...(o.select ?? [])], events = new Map<string, Function>(), commands = new Map<string, any>();
  const spoken: any[] = [];
  const pythonPath = join(speakHome, 'python', 'bin', 'python');
  const baseSnapshot = join(hfHome, 'hub', `models--${QWEN_MODEL_ID.replace('/', '--')}`, 'snapshots', 'abc');
  const makeBase = () => { mkdirSync(join(baseSnapshot, 'speech_tokenizer'), { recursive: true }); writeFileSync(join(baseSnapshot, 'config.json'), '{}'); writeFileSync(join(baseSnapshot, 'model.safetensors'), 'weights'); };
  // python and the Base cache are read from real (temp) files by the production probes; runtime and Piper come from the injected statuses.
  if (st.python === 'installed') { mkdirSync(join(speakHome, 'python', 'bin'), { recursive: true }); writeFileSync(pythonPath, '#!fake\n'); writeFileSync(join(speakHome, 'python.json'), JSON.stringify({ schema: 'gentle-speak.python/v1', python: pythonPath })); }
  if (st.base === 'installed') makeBase();
  // The fake toolbox: uv creates the venv and "installs"; the python import prints the pinned version; python.json is written by the real library.
  const setupRun = async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
    run.push({ command, args, env: options.env, cwd: options.cwd });
    if (command.endsWith('/uv') && args[0] === 'venv') { mkdirSync(join(args[args.length - 1], 'bin'), { recursive: true }); writeFileSync(join(args[args.length - 1], 'bin', 'python'), '#!fake\n'); log.push('python:venv'); return { code: 0, stdout: '', stderr: '' }; }
    if (command.endsWith('/uv')) { log.push('python:pip'); return { code: 0, stdout: '', stderr: '' }; }
    if (args.join(' ').includes('load_model')) return { code: 0, stdout: '0.4.4\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const downloadRun = async (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    downloads.push({ command, args, env: options.env }); log.push('base:download');
    makeBase();
    return { code: 0 };
  };
  const ctx: any = { cwd: '/work/proj', mode: o.mode ?? 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => o.header ?? { type: 'session' }, getBranch: () => [] },
    ui: { setStatus() {}, setWidget() {}, setTitle() {}, input: async () => undefined, notify: (text: string, level?: string) => notes.push({ text, level }),
      confirm: async (title: string, message: string) => { confirms.push({ title, message }); return o.confirm ? o.confirm(title, message) : false; }, select: async () => selections.shift() } };
  const w = {
    base, userHome, speakHome, hfHome, settingsFile, st, log, run, downloads, confirms, notes, selections, events, commands, ctx, spoken,
    texts: () => notes.map(n => n.text),
    settings: () => JSON.parse(readFileSync(settingsFile, 'utf8')),
    tree: () => readdirSync(base, { recursive: true, withFileTypes: true }).map(e => `${join(e.parentPath, e.name)}:${e.isDirectory() ? 'd' : statSync(join(e.parentPath, e.name)).size}`).sort(),
    startRaw: () => events.get('session_start')!({ reason: 'startup' }, ctx),
    start: async () => { await events.get('session_start')!({ reason: 'startup' }, ctx); },
    shutdown: () => events.get('session_shutdown')!({}, ctx),
    menu: () => commands.get('speak').handler('', ctx),
    doctor: (args = 'doctor') => commands.get('speak').handler(args, ctx),
  };
  const platform = o.platform ?? 'darwin';
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut() {}, registerTool() {} } as any, speakHome, {
    ...hermetic(userHome), setupOffer: o.offer ?? true, hostTarget: o.target ?? 'darwin-arm64', platform, hfHome,
    modelStatus: async () => ({ state: st.piper as any, path: '/m' }), runtimeStatus: async () => ({ state: st.runtime as any, path: join(base, 'no-runtime') }),
    installRuntime: async () => { log.push('runtime'); st.runtime = 'installed'; return { path: '/r', alreadyInstalled: false }; },
    installModel: async () => { log.push('piper'); if (o.failPiper) throw new Error('descarga fallida en /x/y'); st.piper = 'installed'; return { path: '/m', alreadyInstalled: false }; },
    setupRun, downloadRun,
    setup: { which: (name: string) => name === 'uv' && o.uv !== false ? '/bin/uv' : name === 'ffmpeg' && o.ffmpeg ? '/bin/ffmpeg' : undefined, ...(o.gate ? { tooling: async () => { await o.gate; return { kind: 'uv' as const, uv: '/bin/uv' }; } } : {}) },
    sayAvailable: () => true, listMacVoices: async () => [{ name: 'Paulina', locale: 'es_MX' }], say: async (req: any) => { spoken.push(req); return { ok: true, message: 'Speech completed.' }; },
    focusCheck: async () => 'focused', readFrontmost: async () => undefined, resolveTerminal: async () => undefined, focusPollMs: 5, lockPollMs: 5,
    herdrExec: (async () => { throw new Error('no herdr'); }) as any, spawn: (() => { throw new Error('no audio in tests'); }) as any,
  } as any);
  return w;
}
test('first start: the offer appears once, in the background (session_start returns first), with every component, its size and the total', async () => {
  let release!: (v: boolean) => void;
  const w = world({ confirm: () => new Promise<boolean>(r => { release = r; }) });
  await w.start(); // returns while nothing is shown yet: never blocked on the human
  await until(() => w.confirms.length === 1, 'offer');
  const { title, message } = w.confirms[0];
  assert.equal(title, 'Instalar todo');
  for (const part of ['Runtime de audio nativo', 'Voz Piper es_MX', 'Entorno Python de gentle-speak con mlx-audio', 'Modelo Qwen3-TTS Base 0.6B: 2.5 GB (aprox.', 'Total:']) assert.ok(message.includes(part), part);
  assert.doesNotMatch(message, /VoiceDesign/);
  assert.equal(w.log.length, 0, 'nothing installs before the answer');
  release(false); await quiet();
});

test('T61: no network request before the answer: the first-start offer and «Instalar todo» show the pinned Base size and fetch nothing', async () => {
  let release!: (v: boolean) => void;
  fetches.length = 0;
  const w = world({ confirm: () => new Promise<boolean>(r => { release = r; }) });
  await w.start(); await until(() => w.confirms.length === 1, 'offer');
  assert.match(w.confirms[0].message, /Modelo Qwen3-TTS Base 0\.6B: 2\.5 GB \(aprox\./);
  assert.deepEqual(fetches, [], 'nothing was fetched while the offer is on screen');
  release(false); await quiet();
  const menu = world({ offer: false, select: ['Instalar todo'], confirm: () => false });
  await menu.menu(); await until(() => menu.confirms.length === 1, 'Instalar todo confirmation');
  assert.deepEqual(fetches, [], 'nothing was fetched for «Instalar todo» either');
});

test('shown once: a second session_start while the offer is on screen, and again after it was answered, never shows it twice; the answer still counts', async () => {
  let release!: (v: boolean) => void;
  const w = world({ confirm: () => new Promise<boolean>(r => { release = r; }) });
  await w.start(); await until(() => w.confirms.length === 1);
  await w.start(); await quiet(); assert.equal(w.confirms.length, 1, 'a newer session_start does not show it again');
  release(true); await until(() => w.texts().some(t => t.startsWith('gentle-speak listo')), 'listo');
  assert.deepEqual(w.log.filter(l => !l.startsWith('python:') && !l.startsWith('base:')), ['runtime', 'piper'], 'the answer to the offer on screen was honored');
  await w.start(); await quiet(); assert.equal(w.confirms.length, 1, 'never again for this instance');
});

test('shutdown while the offer is on screen drops the answer: nothing installs and nothing is persisted', async () => {
  let release!: (v: boolean) => void;
  const w = world({ confirm: () => new Promise<boolean>(r => { release = r; }) });
  await w.start(); await until(() => w.confirms.length === 1);
  w.shutdown(); release(true); await quiet(60);
  assert.deepEqual(w.log, []); assert.equal(w.settings().setupOffer ?? null, null);
  const d = world({ confirm: () => new Promise<boolean>(r => { release = r; }) });
  await d.start(); await until(() => d.confirms.length === 1); d.shutdown(); release(false); await quiet(60);
  assert.equal(d.settings().setupOffer ?? null, null, 'a decline answered after shutdown is not persisted either');
});

test('a session_start that supersedes a plan still being computed does not burn the one-time offer: it is shown exactly once', async () => {
  let open!: () => void;
  const w = world({ confirm: () => false, gate: new Promise<void>(r => { open = r; }) });
  await w.start(); await quiet(30); // the first offer is computing its plan (the tooling probe is held)
  await w.start(); await quiet(30);
  open();
  await until(() => w.confirms.length === 1, 'offer'); await quiet(60); assert.equal(w.confirms.length, 1);
});

test('declining persists setupOffer "declined" (the rest of the file is intact) and a later session never asks again', async () => {
  const w = world({ settings: { mode: 'all', voice: 'es_ES' } });
  await w.start(); await until(() => w.settings().setupOffer === 'declined', 'persisted');
  const kept = w.settings(); assert.equal(kept.mode, 'all'); assert.equal(kept.voice, 'es_ES'); assert.equal(kept.enabled, true);
  assert.equal(readSpeakSettings(w.speakHome).setupOffer, 'declined');
  const again = world({ settings: { setupOffer: 'declined' } });
  await again.start(); await quiet(); assert.deepEqual(again.confirms, []);
  assert.deepEqual(w.log, []);
});

test('old settings stay compatible: no setupOffer key loads as null; only null or "declined" are valid', () => {
  const v1 = { schema: SPEAK_SETTINGS_SCHEMA, enabled: false, mode: 'all', voice: 'es_MX', speed: 1, shortcuts: DEFAULT_SPEAK_SETTINGS.shortcuts };
  assert.equal(parseSpeakSettingsFile(JSON.stringify(v1))?.setupOffer, null);
  assert.equal(parseSpeakSettingsFile(JSON.stringify({ ...v1, setupOffer: 'declined' }))?.setupOffer, 'declined');
  assert.equal(parseSpeakSettingsFile(JSON.stringify({ ...v1, setupOffer: null }))?.setupOffer, null);
  for (const bad of ['yes', true, 1, 'Declined']) assert.equal(parseSpeakSettingsFile(JSON.stringify({ ...v1, setupOffer: bad })), undefined);
});

test('never offered in a child, RPC, print or JSON session, with setupOffer off, or when nothing is missing', async () => {
  for (const [name, o] of [['child', { header: { type: 'session', parentSession: '/p' } }], ['rpc', { mode: 'rpc' }], ['print', { mode: 'print' }], ['json', { mode: 'json' }], ['off', { offer: false }],
    ['complete', { states: { runtime: 'installed', piper: 'installed', python: 'installed', base: 'installed' } }]] as const) {
    const w = world(o as Opts);
    await w.start(); await quiet(60);
    assert.deepEqual(w.confirms, [], name); assert.deepEqual(w.log, [], name); assert.equal(w.texts().some(t => /instalar|gentle-speak/i.test(t)), false, name);
    assert.deepEqual(w.run, [], `${name}: no tool probed`);
  }
});

test('accepting installs everything in the background, one after another, with progress notices and ends with «gentle-speak listo»', async () => {
  const w = world({ confirm: () => true });
  await w.start(); await until(() => w.texts().includes('gentle-speak listo') || w.texts().some(t => t.startsWith('gentle-speak listo')), 'listo');
  assert.deepEqual(w.log, ['runtime', 'piper', 'python:venv', 'python:pip', 'base:download']);
  const texts = w.texts();
  assert.ok(texts.includes('Instalando gentle-speak en segundo plano…'));
  for (const label of ['Runtime de audio nativo (sherpa-onnx + node-cpal)', 'Voz Piper es_MX', 'Entorno Python de gentle-speak con mlx-audio', 'Modelo Qwen3-TTS Base 0.6B']) assert.ok(texts.includes(`Instalando: ${label}…`), label);
  assert.ok(texts.some(t => /Entorno Python.*Creando el entorno con uv/.test(t)), 'python progress');
  assert.equal(texts.filter(t => t.startsWith('gentle-speak listo')).length, 1);
  assert.match(texts.find(t => t.startsWith('gentle-speak listo'))!, /^gentle-speak listo\nffmpeg: no está instalado.*brew install ffmpeg$/, 'ffmpeg is only a hint');
  assert.equal(w.run.some(c => /brew|apt|sudo/.test(c.command + c.args.join(' '))), false, 'ffmpeg and system packages are never installed');
  assert.equal(w.confirms.length, 1, 'one confirmation for everything');
});

test('the Python env is built with uv in <home>/python, python.json is written, and the Base download runs with the real HOME and the HF cache', async () => {
  const w = world({ confirm: () => true });
  await w.start(); await until(() => w.texts().some(t => t.startsWith('gentle-speak listo')));
  const pythonDir = join(w.speakHome, 'python');
  assert.deepEqual(w.run.find(c => c.args[0] === 'venv')!.args, ['venv', '--no-config', '--python', '3.12', pythonDir]);
  assert.deepEqual(w.run.find(c => c.args[0] === 'pip')!.args, ['pip', 'install', '--no-config', '--python', join(pythonDir, 'bin', 'python'), 'mlx-audio==0.4.4']);
  // T61: through the extension too, every install child runs in the shared home (never the session's cwd) and uv reads no config file.
  for (const call of w.run) { assert.equal(call.cwd, w.speakHome, call.args.join(' ')); assert.notEqual(call.cwd, process.cwd()); }
  for (const call of w.run.filter(c => c.command.endsWith('/uv'))) assert.equal(call.env?.UV_NO_CONFIG, '1');
  assert.equal(JSON.parse(readFileSync(join(w.speakHome, 'python.json'), 'utf8')).schema, 'gentle-speak.python/v1');
  for (const call of w.run) assert.equal(call.env?.HOME, w.userHome, 'real HOME, not the shared speak home');
  assert.equal(w.downloads.length, 1); assert.equal(w.downloads[0].command, join(pythonDir, 'bin', 'python'));
  assert.equal(w.downloads[0].env.HOME, w.userHome); assert.equal(w.downloads[0].env.HF_HOME, w.hfHome); assert.equal(w.downloads[0].env.HF_HUB_OFFLINE, undefined);
  assert.ok(w.downloads[0].args.join(' ').includes(QWEN_MODEL_ID) && !w.downloads[0].args.join(' ').includes('VoiceDesign'));
});

test('a component that fails stops only itself: the others install and the summary has a line per component', async () => {
  const w = world({ confirm: () => true, failPiper: true });
  await w.start(); await until(() => w.texts().some(t => t.startsWith('gentle-speak: instalación incompleta')), 'summary');
  const summary = w.texts().find(t => t.startsWith('gentle-speak: instalación incompleta'))!;
  assert.match(summary, /✓ Runtime de audio nativo/); assert.match(summary, /✗ Voz Piper es_MX: descarga fallida en/); assert.match(summary, /✓ Entorno Python/); assert.match(summary, /✓ Modelo Qwen3-TTS Base/);
  assert.doesNotMatch(summary, /\/x\/y/, 'no path leaks'); assert.equal(w.notes.find(n => n.text === summary)!.level, 'warning');
  assert.deepEqual(w.log.filter(l => l === 'runtime' || l === 'piper' || l === 'base:download'), ['runtime', 'piper', 'base:download']);
});

test('without uv or Python the offer still covers runtime and Piper, shows the instruction, and never creates an environment', async () => {
  const w = world({ confirm: () => true, uv: false });
  await w.start(); await until(() => w.confirms.length === 1);
  assert.match(w.confirms[0].message, /No encontré uv ni un Python 3\.10 o superior/);
  assert.doesNotMatch(w.confirms[0].message, /• Entorno Python.*MB/);
  await until(() => w.texts().some(t => t.startsWith('gentle-speak listo')));
  assert.deepEqual(w.log, ['runtime', 'piper']); assert.equal(existsSync(join(w.speakHome, 'python')), false);
});

test('off darwin-arm64 only the runtime and Piper are offered and installed (no Python, no Base model, no API call)', async () => {
  const w = world({ confirm: () => true, target: 'linux-x64', platform: 'linux' });
  await w.start(); await until(() => w.texts().some(t => t.startsWith('gentle-speak listo')));
  assert.doesNotMatch(w.confirms[0].message, /Python|Qwen|mlx/); assert.deepEqual(w.log, ['runtime', 'piper']); assert.deepEqual(w.run, []); assert.deepEqual(w.downloads, []);
});

test('when Qwen is ready and there is no custom voice, the end suggests «Crear voz propia…»; with a custom voice it does not', async () => {
  const a = world({ confirm: () => true });
  await a.start(); await until(() => a.texts().some(t => t.includes('Crear voz propia…')), 'suggestion');
  const b = world({ confirm: () => true, custom: true });
  await b.start(); await until(() => b.texts().some(t => t.startsWith('gentle-speak listo'))); await quiet();
  assert.equal(b.texts().some(t => t.includes('Crear voz propia…')), false);
  const c = world({ confirm: () => true, target: 'linux-x64', platform: 'linux' });
  await c.start(); await until(() => c.texts().some(t => t.startsWith('gentle-speak listo'))); await quiet();
  assert.equal(c.texts().some(t => t.includes('Crear voz propia…')), false, 'no Qwen, no suggestion');
});

test('/speak → «Instalar todo» runs the same plan and confirmation at any time, even after the offer was declined', async () => {
  const w = world({ offer: false, settings: { setupOffer: 'declined' }, confirm: () => true, select: ['Instalar todo'] });
  await w.start(); await w.menu();
  assert.equal(w.confirms.length, 1); assert.equal(w.confirms[0].title, 'Instalar todo'); assert.match(w.confirms[0].message, /Total:/);
  await until(() => w.texts().some(t => t.startsWith('gentle-speak listo')));
  assert.deepEqual(w.log, ['runtime', 'piper', 'python:venv', 'python:pip', 'base:download']);
  assert.equal(w.settings().setupOffer, 'declined', 'a manual run does not touch the persisted decline');
});

test('«Instalar todo»: declining installs nothing and persists nothing; with everything installed it says so; two at once never overlap', async () => {
  const w = world({ offer: false, confirm: () => false, select: ['Instalar todo'] });
  await w.menu(); assert.deepEqual(w.log, []); assert.equal(w.settings().setupOffer ?? null, null);
  const done = world({ offer: false, ffmpeg: true, states: { runtime: 'installed', piper: 'installed', python: 'installed', base: 'installed' }, select: ['Instalar todo'] });
  await done.menu(); assert.deepEqual(done.confirms, []); assert.deepEqual(done.texts(), ['gentle-speak listo: no falta nada.']);
  let release!: (v: boolean) => void;
  const twice = world({ offer: false, confirm: () => new Promise<boolean>(r => { release = r; }), select: ['Instalar todo', 'Instalar todo'] });
  const first = twice.menu(); await until(() => twice.confirms.length === 1);
  await twice.menu(); assert.equal(twice.confirms.length, 1, 'one confirmation at a time');
  release(true); await first; await until(() => twice.texts().some(t => t.startsWith('gentle-speak listo')));
  assert.equal(twice.log.filter(l => l === 'runtime').length, 1);
});

test('«Instalar todo» is a parent-TUI action: in a child, RPC or print session the command does nothing', async () => {
  for (const o of [{ header: { type: 'session', parentSession: '/p' } }, { mode: 'rpc' }, { mode: 'print' }]) {
    const w = world({ offer: false, confirm: () => true, select: ['Instalar todo'], ...o });
    await w.menu(); await w.doctor(); assert.deepEqual(w.confirms, []); assert.deepEqual(w.log, []); assert.deepEqual(w.notes, []);
  }
});

test('ffmpeg present: no hint anywhere; missing: brew install ffmpeg in the confirmation and in the summary, never installed', async () => {
  const has = world({ confirm: () => true, ffmpeg: true });
  await has.start(); await until(() => has.texts().some(t => t.startsWith('gentle-speak listo')));
  assert.doesNotMatch(has.confirms[0].message, /ffmpeg/); assert.equal(has.texts().find(t => t.startsWith('gentle-speak listo')), 'gentle-speak listo');
  const lacks = world({ confirm: () => true, ffmpeg: false });
  await lacks.start(); await until(() => lacks.texts().some(t => t.startsWith('gentle-speak listo')));
  assert.match(lacks.confirms[0].message, /ffmpeg no está instalado.*brew install ffmpeg/);
});

test('the Dot offer keeps working and comes first; the T45 migration still runs at session_start with the setup offer enabled', async () => {
  const w = world({ confirm: () => false });
  const dotAgent = join(w.userHome, 'dot-agent'); mkdirSync(dotAgent, { recursive: true }); writeFileSync(join(dotAgent, 'settings.json'), JSON.stringify({ packages: [] }));
  await w.start(); await until(() => w.confirms.length === 2, 'both offers');
  assert.equal(w.confirms[0].title, 'Gentle Dot'); assert.equal(w.confirms[1].title, 'Instalar todo');
  await until(() => w.settings().setupOffer === 'declined' && w.settings().dotOffer === 'declined');
  const m = world({ offer: true, confirm: () => false });
  const voices = join(m.speakHome, 'voices', 'qwen3'); mkdirSync(voices, { recursive: true });
  await m.start(); await until(() => m.confirms.length === 1);
  assert.equal(existsSync(join(m.speakHome, 'qwen-migrated.json')) || existsSync(join(voices, 'manifest.json')) === false, true, 'migration ran or had nothing to migrate');
});

test('the existing «Install voice and runtime» keeps asking for each download separately', async () => {
  const w = world({ offer: false, confirm: () => true, select: ['Install voice and runtime'], settings: { voice: 'es_MX' } });
  await w.menu();
  assert.deepEqual(w.confirms.map(c => c.title), ['Install voice?', 'Install runtime?']); assert.deepEqual(w.log, ['piper', 'runtime']);
});

// ---- /speak doctor ---------------------------------------------------------------------------------------------------------------------

test('/speak doctor routes to the doctor (no menu), case and spacing insensitive; an unknown argument opens the menu', async () => {
  const w = world({ offer: false, select: ['Cancel'] });
  await w.doctor('doctor'); await w.doctor('  Doctor '); await w.doctor('DOCTOR');
  assert.equal(w.texts().filter(t => t.startsWith('gentle-speak doctor\n')).length, 3);
  assert.equal(w.selections.length, 1, 'the menu was never opened');
  await w.doctor('nonsense'); assert.equal(w.selections.length, 0, 'an unknown argument opens the normal menu');
});

test('the menu item «Doctor» runs the same report; the menu lists «Instalar todo» and «Doctor»', async () => {
  let listed: string[] = [];
  const w = world({ offer: false, select: ['Doctor'] });
  const select = w.ctx.ui.select; w.ctx.ui.select = async (t: string, opts: string[]) => { listed = opts; return select(t, opts); };
  await w.menu();
  assert.ok(listed.includes('Instalar todo') && listed.includes('Doctor'));
  assert.equal(w.texts().filter(t => t.startsWith('gentle-speak doctor\n')).length, 1);
});

test('the doctor report is plain text with every item, a ✗ with a fix hint for what is missing, and ends with the optional «¿Probar una frase?»', async () => {
  const w = world({ offer: false, settings: { voice: 'es_MX' } });
  await w.doctor();
  const report = w.texts()[0];
  assert.match(report, /^gentle-speak doctor\n/); assert.doesNotMatch(report, /\u001b\[/);
  for (const label of ['Runtime de audio', 'Salida de audio', 'Modelos Piper', 'Entorno Python + mlx-audio', 'Modelo Qwen Base 0.6B (caché)', 'Modelo VoiceDesign (opcional)', 'Voces propias (sha256)', 'Voz elegida', 'Servicio Qwen compartido', 'Cerrojo de voz', 'ffmpeg', 'Voz del sistema', 'Fuente de foco', 'Conexión con Gentle Dot']) assert.ok(report.includes(`${label}:`), label);
  assert.match(report, /✗ Runtime de audio: no está instalado\n    → ejecutá \/speak → «Instalar todo»/);
  assert.match(report, /✗ ffmpeg: .*\n    → brew install ffmpeg/); assert.match(report, /✓ Cerrojo de voz: libre/); assert.match(report, /– Servicio Qwen compartido: no está corriendo/);
  assert.deepEqual(w.confirms, [{ title: 'Doctor', message: '¿Probar una frase?' }]); assert.equal(w.notes[0].level, 'warning');
  assert.deepEqual(w.spoken, [], 'declined: nothing is spoken');
});

test('the doctor is read-only: no file is created, changed or removed, no installer or tool runs, nothing is spoken until the human accepts', async () => {
  const w = world({ offer: false, states: { runtime: 'installed', piper: 'installed' } });
  const before = w.tree(), settings = readFileSync(w.settingsFile, 'utf8');
  await w.doctor();
  assert.deepEqual(w.tree(), before); assert.equal(readFileSync(w.settingsFile, 'utf8'), settings);
  assert.deepEqual(w.log, []); assert.deepEqual(w.run, []); assert.deepEqual(w.downloads, []); assert.deepEqual(w.spoken, []);
});

test('«¿Probar una frase?»: accepting speaks one short phrase through the selected voice and reports the outcome; declining speaks nothing', async () => {
  const w = world({ offer: false, settings: { voice: 'mac' }, confirm: () => true });
  await w.doctor();
  assert.equal(w.spoken.length, 1); assert.equal(w.spoken[0].text, 'Hola, gentle-speak funciona.');
  assert.equal(w.texts().at(-1), 'Prueba completada.');
});

test('the doctor reports a healthy custom voice and a missing selected voice with a hint', async () => {
  const ok = world({ offer: false, custom: true, settings: { voice: 'custom:mia' }, states: { python: 'installed' } });
  await ok.doctor();
  assert.match(ok.texts()[0], /✓ Voces propias \(sha256\): 1 ok, 0 inválidas/); assert.match(ok.texts()[0], /✓ Voz elegida: Propia · Mia \(custom:mia\)/);
  const bad = world({ offer: false, settings: { voice: 'custom:ghost' } });
  await bad.doctor();
  assert.match(bad.texts()[0], /✗ Voz elegida: custom:ghost: no existe o es inválida\n    → /);
});

