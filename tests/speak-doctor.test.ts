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
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { formatDoctorReport, probeAudioDevice, probeQwenService, probeVoiceLock, runDoctor, type DoctorProbes, type DoctorReport } from '../lib/speak-doctor.ts';

// T44 (S15): `/speak doctor`. Probes are fakes; the real read-only probes run against temp directories. Nothing touches a real path.
const roots: string[] = [];
test.afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = () => { const root = mkdtempSync(join(tmpdir(), 'gs-doc-')); roots.push(root); const home = join(root, '.gentle-speak'); mkdirSync(home, { recursive: true }); return { root, home }; };

const healthy = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  platform: 'darwin', target: 'darwin-arm64',
  runtime: async () => ({ state: 'installed' }), audio: async () => ({ ok: true, detail: '48000 Hz' }),
  piper: async () => ({ es_MX: 'installed', es_ES: 'missing' }),
  python: async () => ({ recorded: true, python: '/h/python/bin/python', exists: true, importOk: true, version: '0.4.4' }),
  base: async () => 'installed', design: async () => 'missing',
  customVoices: async () => ({ voices: [{ id: 'mia' } as any], skipped: [] }),
  selectedVoice: async () => ({ ok: true, detail: 'Propia · Mia (custom:mia)' }),
  service: async () => ({ state: 'running', pid: 4242, version: '0.1.0+p1', build: 'abc123def456', current: true }),
  lock: async () => ({ state: 'free' }), ffmpeg: () => '/opt/homebrew/bin/ffmpeg',
  systemVoice: async () => ({ available: true, detail: '2 voz/voces en español (elegida: Paulina)' }),
  focus: async () => 'terminal-events', dot: () => ({ state: 'ready', connected: true }) as any,
  ...over,
});
const get = (report: DoctorReport, id: string) => report.checks.find(c => c.id === id)!;
const IDS = ['runtime', 'audio', 'piper', 'python', 'base', 'design', 'custom', 'voice', 'service', 'lock', 'ffmpeg', 'system', 'focus', 'dot'];

test('a healthy machine: every check is reported once, nothing fails, and the report is plain text with ✓ marks', async () => {
  const report = await runDoctor(healthy());
  assert.deepEqual(report.checks.map(c => c.id), IDS);
  assert.equal(report.failed, 0); assert.equal(report.ok + report.na, IDS.length);
  const text = formatDoctorReport(report);
  assert.match(text, /^gentle-speak doctor\n/); assert.match(text, /Todo en orden/);
  assert.doesNotMatch(text, /\u001b\[|\n    →/, 'no color, and no hint under a pass');
  assert.equal(text.split('\n').filter(l => /^[✓✗–] /.test(l)).length, IDS.length);
  assert.match(text, /✓ Servicio Qwen compartido: en ejecución, pid 4242, versión 0\.1\.0\+p1, build abc123def456/);
});

test('runtime: missing and invalid fail with a fix hint; installed passes', async () => {
  assert.equal(get(await runDoctor(healthy()), 'runtime').status, 'ok');
  const missing = get(await runDoctor(healthy({ runtime: async () => ({ state: 'missing' }) })), 'runtime');
  assert.deepEqual([missing.status, missing.hint], ['fail', 'ejecutá /speak → «Instalar todo»']);
  const invalid = get(await runDoctor(healthy({ runtime: async () => ({ state: 'invalid' }) })), 'runtime');
  assert.equal(invalid.status, 'fail'); assert.match(invalid.hint!, /Resolvela a mano/);
});

test('audio device: opens (no sound) or fails with the cause; without the runtime it is not probed', async () => {
  const ok = get(await runDoctor(healthy()), 'audio'); assert.equal(ok.status, 'ok'); assert.match(ok.detail, /48000 Hz.*sin sonido/);
  const bad = get(await runDoctor(healthy({ audio: async () => ({ ok: false, detail: 'no default output device' }) })), 'audio');
  assert.equal(bad.status, 'fail'); assert.match(bad.detail, /no default output device/); assert.match(bad.hint!, /dispositivo de salida/);
  let probed = false;
  const none = get(await runDoctor(healthy({ runtime: async () => ({ state: 'missing' }), audio: async () => { probed = true; return { ok: true }; } })), 'audio');
  assert.equal(none.status, 'fail'); assert.equal(probed, false); assert.match(none.detail, /falta el runtime/);
});

test('piper: es_MX installed passes; otherwise fails; both voices are listed', async () => {
  assert.match(get(await runDoctor(healthy()), 'piper').detail, /es_MX instalado, es_ES no instalado/);
  const bad = get(await runDoctor(healthy({ piper: async () => ({ es_MX: 'invalid', es_ES: 'installed' }) })), 'piper');
  assert.equal(bad.status, 'fail'); assert.match(bad.detail, /es_MX inválido/);
});

test('python env + mlx-audio import: not recorded, interpreter gone, import fails, passes', async () => {
  assert.match(get(await runDoctor(healthy()), 'python').detail, /mlx-audio 0\.4\.4/);
  const none = get(await runDoctor(healthy({ python: async () => ({ recorded: false }) })), 'python');
  assert.deepEqual([none.status, /uv o Python 3\.10\+/.test(none.hint!)], ['fail', true]);
  const gone = get(await runDoctor(healthy({ python: async () => ({ recorded: true, exists: false }) })), 'python');
  assert.deepEqual([gone.status, gone.detail], ['fail', 'el intérprete registrado ya no existe']);
  const broken = get(await runDoctor(healthy({ python: async () => ({ recorded: true, exists: true, importOk: false, message: 'ModuleNotFoundError' }) })), 'python');
  assert.equal(broken.status, 'fail'); assert.match(broken.detail, /mlx_audio no se importa: ModuleNotFoundError/);
});

test('Base cache fails when absent; VoiceDesign cache is optional (– when absent, ✓ when present, never ✗)', async () => {
  assert.equal(get(await runDoctor(healthy()), 'base').status, 'ok');
  assert.equal(get(await runDoctor(healthy({ base: async () => 'missing' })), 'base').status, 'fail');
  const absent = get(await runDoctor(healthy()), 'design'); assert.deepEqual([absent.status, /opcional/.test(absent.detail)], ['na', true]);
  assert.equal(get(await runDoctor(healthy({ design: async () => 'installed' })), 'design').status, 'ok');
});

test('custom voices (sha256): counts ok and invalid; none is not a failure', async () => {
  assert.equal(get(await runDoctor(healthy()), 'custom').detail, '1 ok, 0 inválidas');
  const none = get(await runDoctor(healthy({ customVoices: async () => ({ voices: [], skipped: [] }) })), 'custom'); assert.equal(none.status, 'na');
  const bad = get(await runDoctor(healthy({ customVoices: async () => ({ voices: [{ id: 'a' } as any, { id: 'b' } as any], skipped: [{ id: 'c', reason: 'sha256' } as any] }) })), 'custom');
  assert.deepEqual([bad.status, bad.detail], ['fail', '2 ok, 1 inválida (c)']); assert.match(bad.hint!, /Borrar voz propia/);
});

test('selected voice: resolvable passes; not resolvable fails with its own hint', async () => {
  assert.equal(get(await runDoctor(healthy()), 'voice').status, 'ok');
  const bad = get(await runDoctor(healthy({ selectedVoice: async () => ({ ok: false, detail: 'custom:x: no existe o es inválida', hint: 'Elegí otra voz con /speak o creala de nuevo.' }) })), 'voice');
  assert.deepEqual([bad.status, bad.hint], ['fail', 'Elegí otra voz con /speak o creala de nuevo.']);
});

test('shared Qwen service: running with pid, version and build; a build that is not the current one says it is replaced; stale fails; absent is a note about the local fallback', async () => {
  const old = get(await runDoctor(healthy({ service: async () => ({ state: 'running', pid: 7, version: '0.1.0+p1', build: 'old', current: false }) })), 'service');
  assert.equal(old.status, 'ok'); assert.match(old.detail, /pid 7.*build old.*lo reemplaza solo/);
  const stale = get(await runDoctor(healthy({ service: async () => ({ state: 'stale', reason: 'el proceso 7 ya no existe' }) })), 'service');
  assert.equal(stale.status, 'fail'); assert.match(stale.detail, /el proceso 7 ya no existe/); assert.match(stale.hint!, /Detener servicio Qwen/);
  const absent = get(await runDoctor(healthy({ service: async () => ({ state: 'absent' }) })), 'service');
  assert.equal(absent.status, 'na'); assert.match(absent.detail, /worker local por sesión/);
});

test('voice lock: free, held by a live process, or left by a dead one (never a failure: it is reclaimed)', async () => {
  assert.equal(get(await runDoctor(healthy()), 'lock').detail, 'libre');
  assert.match(get(await runDoctor(healthy({ lock: async () => ({ state: 'owned', pid: 9, alive: true }) })), 'lock').detail, /proceso vivo 9/);
  const dead = get(await runDoctor(healthy({ lock: async () => ({ state: 'owned', pid: 9, alive: false }) })), 'lock');
  assert.equal(dead.status, 'ok'); assert.match(dead.detail, /ya no existe/);
});

test('ffmpeg: found passes; missing fails with brew install ffmpeg on macOS and the platform hint elsewhere', async () => {
  assert.equal(get(await runDoctor(healthy()), 'ffmpeg').status, 'ok');
  const mac = get(await runDoctor(healthy({ ffmpeg: () => undefined })), 'ffmpeg'); assert.deepEqual([mac.status, mac.hint], ['fail', 'brew install ffmpeg']);
  assert.match(get(await runDoctor(healthy({ ffmpeg: () => undefined, platform: 'linux', target: 'linux-x64' })), 'ffmpeg').hint!, /apt install ffmpeg/);
});

test('system voice: voices found pass; none or unavailable fail with the platform hint', async () => {
  assert.match(get(await runDoctor(healthy()), 'system').detail, /Paulina/);
  const none = get(await runDoctor(healthy({ systemVoice: async () => ({ available: false, detail: 'no hay voces en español instaladas' }) })), 'system');
  assert.equal(none.status, 'fail'); assert.match(none.hint!, /Contenido hablado/);
  const linuxMissing = get(await runDoctor(healthy({ platform: 'linux', target: 'linux-x64', systemVoice: async () => ({ available: false, detail: 'falta `spd-say` (speech-dispatcher) o `espeak-ng`' }) })), 'system');
  assert.equal(linuxMissing.status, 'fail'); assert.match(linuxMissing.hint!, /sudo apt install speech-dispatcher espeak-ng/);
  const linuxOk = get(await runDoctor(healthy({ platform: 'linux', target: 'linux-x64', systemVoice: async () => ({ available: true, detail: 'espeak-ng: 2 voz/voces en español (elegida: spanish-latam)' }) })), 'system');
  assert.equal(linuxOk.status, 'ok'); assert.match(linuxOk.detail, /espeak-ng/);
  const win = get(await runDoctor(healthy({ platform: 'win32', target: 'win32-x64', systemVoice: async () => ({ available: false, detail: 'SAPI: no hay voces en español instaladas' }) })), 'system');
  assert.equal(win.status, 'fail'); assert.match(win.hint!, /integrada en Windows/);
});

test('focus source: terminal events, Herdr, or unknown (never a failure)', async () => {
  assert.match(get(await runDoctor(healthy()), 'focus').detail, /eventos de foco de la terminal/);
  assert.equal(get(await runDoctor(healthy({ focus: async () => 'herdr' })), 'focus').detail, 'Herdr');
  const unknown = get(await runDoctor(healthy({ focus: async () => 'unknown' })), 'focus'); assert.deepEqual([unknown.status, /por turnos/.test(unknown.detail)], ['na', true]);
});

test('Gentle Dot connection: connected, installed but not connected, malformed, absent', async () => {
  assert.equal(get(await runDoctor(healthy()), 'dot').detail, 'conectado');
  assert.match(get(await runDoctor(healthy({ dot: () => ({ state: 'ready', connected: false }) as any })), 'dot').detail, /no conectado/);
  const bad = get(await runDoctor(healthy({ dot: () => ({ state: 'malformed' }) as any })), 'dot'); assert.deepEqual([bad.status, /mal formado/.test(bad.detail)], ['fail', true]);
  assert.equal(get(await runDoctor(healthy({ dot: () => ({ state: 'absent' }) as any })), 'dot').status, 'na');
});

test('off Apple Silicon the Qwen checks (python, Base, VoiceDesign, service) do not apply and never probe', async () => {
  const probed: string[] = [];
  const spy = (name: string, value: any) => async () => { probed.push(name); return value; };
  const report = await runDoctor(healthy({ target: 'linux-x64', platform: 'linux', python: spy('python', { recorded: false }), base: spy('base', 'missing'), design: spy('design', 'missing'), service: spy('service', { state: 'absent' }) }));
  assert.deepEqual(probed, []); for (const id of ['python', 'base', 'design', 'service']) assert.equal(get(report, id).status, 'na', id);
  assert.equal(report.failed, 0);
});

test('a probe that throws or hangs becomes a ✗ for that check only, within the bound; the others still run', async () => {
  const started = Date.now();
  const report = await runDoctor(healthy({ timeoutMs: 40, base: async () => { throw new Error('EACCES /secret/dir'); }, piper: () => new Promise(() => {}) }));
  assert.ok(Date.now() - started < 2000, 'bounded');
  const base = get(report, 'base'), piper = get(report, 'piper');
  assert.equal(base.status, 'fail'); assert.match(base.detail, /no pude comprobarlo \(EACCES\)/); assert.doesNotMatch(base.detail, /secret/, 'paths never leak');
  assert.equal(piper.status, 'fail'); assert.match(piper.detail, /sin respuesta tras/);
  assert.equal(report.failed, 2); assert.equal(get(report, 'runtime').status, 'ok'); assert.equal(report.checks.length, IDS.length);
});

test('failures print an indented fix hint under their line and a count; the report reads as plain text', async () => {
  const text = formatDoctorReport(await runDoctor(healthy({ runtime: async () => ({ state: 'missing' }), ffmpeg: () => undefined })));
  assert.match(text, /✗ Runtime de audio: no está instalado\n    → ejecutá \/speak → «Instalar todo»/);
  assert.match(text, /✗ ffmpeg: .*\n    → brew install ffmpeg/);
  assert.match(text, /3 problemas \(✗\)/, 'runtime, audio (needs the runtime) and ffmpeg');
  assert.match(text, /no aplica o es opcional \(–\)\.$/);
});

// ---- the real read-only probes ---------------------------------------------------------------------------------------------------------

const tree = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).map(e => `${join(e.parentPath, e.name)}:${e.isDirectory() ? 'd' : statSync(join(e.parentPath, e.name)).size}`).sort();

test('probeVoiceLock reads the owner without writing: free, live owner, dead owner', async () => {
  const { home } = tmp();
  assert.deepEqual(await probeVoiceLock(home), { state: 'free' });
  mkdirSync(join(home, 'voice.lock')); writeFileSync(join(home, 'voice.lock', 'owner.json'), JSON.stringify({ pid: 321 }));
  const before = tree(home);
  assert.deepEqual(await probeVoiceLock(home, pid => pid === 321), { state: 'owned', pid: 321, alive: true });
  assert.deepEqual(await probeVoiceLock(home, () => false), { state: 'owned', pid: 321, alive: false });
  writeFileSync(join(home, 'voice.lock', 'owner.json'), '{broken');
  assert.deepEqual(await probeVoiceLock(home), { state: 'free' }, 'a lock being created or released is not an error');
  rmSync(join(home, 'voice.lock', 'owner.json')); writeFileSync(join(home, 'voice.lock', 'owner.json'), JSON.stringify({ pid: 321 }));
  assert.deepEqual(tree(home), before, 'nothing was written or removed');
});

test('probeQwenService reads the socket file, pid and the service log line; it never connects and never writes', async () => {
  const { home } = tmp();
  assert.deepEqual(await probeQwenService(home), { state: 'absent' });
  writeFileSync(join(home, 'qwen.sock'), 'x');
  assert.equal((await probeQwenService(home) as any).state, 'stale'); assert.match((await probeQwenService(home) as any).reason, /no es un socket/);
  rmSync(join(home, 'qwen.sock'));
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(done => server.listen(join(home, 'qwen.sock'), done));
  try {
    writeFileSync(join(home, 'qwen-service.pid'), '4242\n');
    writeFileSync(join(home, 'qwen-service.log'), [
      '2026-11-10T22:06:00.000Z [qwen-service 111] listening on /x/qwen.sock (version 0.1.0+p1, build unknown, grace 300000)',
      '2026-11-11T18:02:11.000Z [qwen-service 4242] listening on /x/qwen.sock (version 0.1.0+p1, build abc123def456, grace 600000)',
      '2026-11-11T18:03:00.000Z [qwen-service 4242] worker ready',
    ].join('\n') + '\n');
    const before = tree(home);
    const alive = (pid: number) => pid === 4242;
    assert.deepEqual(await probeQwenService(home, { isPidAlive: alive }), { state: 'running', pid: 4242, version: '0.1.0+p1', build: 'abc123def456', current: undefined });
    assert.equal((await probeQwenService(home, { isPidAlive: alive, expected: { version: '0.1.0+p1', build: 'abc123def456' } }) as any).current, true);
    assert.equal((await probeQwenService(home, { isPidAlive: alive, expected: { version: '0.1.0+p1', build: 'ffffffffffff' } }) as any).current, false, 'another build');
    assert.equal((await probeQwenService(home, { isPidAlive: alive, expected: { version: '0.2.0+p1', build: 'abc123def456' } }) as any).current, false, 'another version');
    assert.deepEqual(await probeQwenService(home, { isPidAlive: () => false }), { state: 'stale', reason: 'el proceso 4242 ya no existe' });
    rmSync(join(home, 'qwen-service.log'));
    assert.deepEqual(await probeQwenService(home, { isPidAlive: alive }), { state: 'running', pid: 4242, version: undefined, build: undefined, current: undefined }, 'no log: the pid alone');
    assert.equal(connections, 0, 'a connection would count as a client of the service and restart its grace countdown');
    assert.equal(existsSync(join(home, 'qwen-service.restart')), false);
    assert.deepEqual(tree(home).filter(entry => !/qwen-service\.log/.test(entry)), before.filter(entry => !/qwen-service\.log/.test(entry)), 'nothing was written or removed');
  } finally { await new Promise(done => server.close(done)); }
});

test('probeAudioDevice runs the silent probe script in a child with the runtime path and parses its one JSON line', async () => {
  const seen: any[] = [];
  const exec = ((file: string, args: string[], options: any, cb: Function) => { seen.push({ file, args, timeout: options.timeout }); cb(null, `${JSON.stringify({ ok: true, rate: 24000, channels: 2 })}\n`, ''); }) as any;
  assert.deepEqual(await probeAudioDevice({ script: '/s/probe.cjs', runtimePath: '/r', timeoutMs: 1234, exec }), { ok: true, detail: '24000 Hz' });
  assert.deepEqual(seen, [{ file: process.execPath, args: ['/s/probe.cjs', '/r'], timeout: 1234 }]);
  const bad = ((file: string, args: string[], options: any, cb: Function) => cb(new Error('x'), `${JSON.stringify({ ok: false, message: 'no default output device' })}\n`, '')) as any;
  assert.deepEqual(await probeAudioDevice({ script: '/s', runtimePath: '/r', exec: bad }), { ok: false, detail: 'no default output device' });
  const killed = ((file: string, args: string[], options: any, cb: Function) => cb(new Error('killed'), '', '')) as any;
  assert.deepEqual(await probeAudioDevice({ script: '/s', runtimePath: '/r', exec: killed }), { ok: false, detail: 'el sondeo no terminó a tiempo' });
});

test('the real probe script fails closed without a valid runtime (no device is opened) and prints one JSON line', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = resolve(import.meta.dirname, '../scripts/speak-audio-probe.cjs');
  const { root } = tmp();
  for (const arg of ['relative/path', root]) {
    let out = '';
    try { out = execFileSync(process.execPath, [script, arg], { encoding: 'utf8', timeout: 10_000 }); } catch (error: any) { out = String(error.stdout); }
    const reply = JSON.parse(out.trim().split('\n').pop()!);
    assert.equal(reply.ok, false); assert.equal(typeof reply.message, 'string'); assert.doesNotMatch(reply.message, /\//, 'no path in the message');
  }
  assert.equal(readFileSync(script, 'utf8').includes('fill(0)'), true, 'the stream callback writes silence');
});

test('T49 R1-002: probeAudioDevice never spawns for a runtime that is not installed or a path that is not absolute', async () => {
  let spawned = 0; const exec = ((..._a: unknown[]) => { spawned++; }) as any;
  for (const [runtimeState, runtimePath] of [['missing', '/r'], ['invalid', '/r'], [undefined, 'relative/r'], ['installed', ''], ['installed', '-e'], ['installed', '/r\0x']] as const) {
    const out = await probeAudioDevice({ script: '/s/probe.cjs', runtimePath, runtimeState, exec });
    assert.equal(out.ok, false); assert.equal(typeof out.detail, 'string');
  }
  assert.equal(spawned, 0);
});

test('T49 R1-002: the probe child gets a minimal environment, a bounded buffer and a kill timeout; installed runtimes still probe', async () => {
  const seen: any[] = [];
  const exec = ((file: string, args: string[], options: any, cb: Function) => { seen.push({ args, options }); cb(null, `${JSON.stringify({ ok: true, rate: 1e99 })}\n`, ''); }) as any;
  process.env.T49_CANARY = 'x';
  try { assert.deepEqual(await probeAudioDevice({ script: '/s/probe.cjs', runtimePath: '/r', runtimeState: 'installed', exec }), { ok: true, detail: undefined }); } finally { delete process.env.T49_CANARY; }
  assert.deepEqual(seen[0].args, ['/s/probe.cjs', '/r']);
  assert.equal(typeof seen[0].options.env, 'object'); assert.equal(seen[0].options.env.T49_CANARY, undefined);
  assert.ok(seen[0].options.maxBuffer <= 64 * 1024); assert.ok(seen[0].options.timeout > 0);
});
