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
import { POSIX_MODES } from './helpers/platform.ts';
// T42 / S14: scripts/speak-design-voice.py. Design is tested through `--dry-run` (no model is loaded); import is tested for real, with ffmpeg only for conversions.
// Runs with the same flags as the Qwen worker (`-E -P`). Scratch lives under mkdtemp and is removed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QWEN_PYTHON_FLAGS } from '../lib/speak-voices.ts';
import { defaultPythonRun, inspectWav, runVoiceScript } from '../lib/speak-custom-voices.ts';
import { makeWav } from './helpers/custom-voice-fixture.ts';

const SCRIPT = resolve(import.meta.dirname, '../scripts/speak-design-voice.py');
const have = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const PY = (() => { try { return execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; } })(); // absolute: some tests run with an empty PATH
const FFMPEG = have('ffmpeg', ['-version']);
const opts = { skip: PY ? false : 'python3 is not available' };
const SAMPLE = 'Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad. Ya está arreglado.';
const DESCRIPTION = 'Una voz femenina adulta, cálida y cercana, con acento mexicano.';

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'gs-design-'));
  const out = join(dir, 'out');
  return { dir, out, close: () => rmSync(dir, { recursive: true, force: true }) };
}
function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(PY!, [...QWEN_PYTHON_FLAGS, SCRIPT, ...args], { encoding: 'utf8', env });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { status: r.status, stdout: r.stdout, lines, json: lines.length ? JSON.parse(lines[lines.length - 1]) : undefined, stderr: r.stderr };
}

test('design --dry-run writes reference.wav (PCM16 mono, 3-30 s) and prints one JSON line without paths', opts, () => {
  const s = scratch();
  try {
    const r = run(['design', '--dry-run', '--description', DESCRIPTION, '--sample', SAMPLE, '--language', 'es', '--out', s.out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.lines.length, 1);
    assert.equal(r.json.ok, true); assert.equal(r.json.mode, 'design'); assert.equal(r.json.file, 'reference.wav');
    assert.deepEqual(readdirSync(s.out), ['reference.wav']);
    const info = inspectWav(readFileSync(join(s.out, 'reference.wav')));
    assert.equal(info.channels, 1); assert.equal(info.bits, 16);
    assert.ok(Math.abs(r.json.seconds - info.seconds) < 0.01);
    assert.equal(r.stdout.includes(s.dir), false, 'no path in the output');
    if (POSIX_MODES) assert.equal(statSync(join(s.out, 'reference.wav')).mode & 0o077, 0, 'private file'); // T62: Windows has no permission bits
  } finally { s.close(); }
});

test('design rejects bad input with a JSON error, exit 2 and no file', opts, () => {
  const s = scratch();
  try {
    const good = ['--description', DESCRIPTION, '--sample', SAMPLE, '--language', 'es', '--out', s.out, '--dry-run'];
    const swap = (flag: string, value: string) => { const copy = [...good]; copy[copy.indexOf(flag) + 1] = value; return copy; };
    for (const [name, args, code] of [
      ['short description', swap('--description', 'corta'), 'bad_description'], ['long description', swap('--description', 'x'.repeat(601)), 'bad_description'],
      ['control chars', swap('--description', 'una voz\u0007 cálida y cercana'), 'bad_description'],
      ['short sample', swap('--sample', 'Hola.'), 'bad_sample'], ['long sample', swap('--sample', 'x'.repeat(401)), 'bad_sample'],
      ['language', swap('--language', 'xx'), 'bad_language'],
    ] as const) {
      const r = run(['design', ...args]);
      assert.equal(r.status, 2, name); assert.equal(r.lines.length, 1, name);
      assert.deepEqual({ ok: r.json.ok, code: r.json.code }, { ok: false, code }, name);
      assert.equal(r.stdout.includes(s.dir), false, name);
    }
    assert.equal(readdirSync(s.dir).length === 0 || readdirSync(s.out).length === 0, true, 'nothing written');
  } finally { s.close(); }
});

const importArgs = (s: ReturnType<typeof scratch>, file: string, transcript = 'Hola, esta es mi voz de prueba.') => ['import', '--wav', file, '--transcript', transcript, '--out', s.out];
const writeIn = (s: ReturnType<typeof scratch>, name: string, data: Buffer) => { const path = join(s.dir, name); writeFileSync(path, data); return path; };

test('import copies a PCM16 mono 3-30 s WAV byte for byte without ffmpeg', opts, () => {
  const s = scratch();
  try {
    const wav = makeWav(4);
    const r = run(importArgs(s, writeIn(s, 'in.wav', wav)), { ...process.env, PATH: '' });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.lines.length, 1);
    assert.equal(r.json.ok, true); assert.equal(r.json.mode, 'import'); assert.equal(r.json.converted, false); assert.equal(r.json.file, 'reference.wav');
    assert.deepEqual(readFileSync(join(s.out, 'reference.wav')), wav);
    assert.deepEqual(readdirSync(s.out), ['reference.wav']);
    assert.equal(r.stdout.includes(s.dir), false, 'the input path is never echoed');
  } finally { s.close(); }
});

test('import converts stereo or non-16-bit PCM to PCM16 mono with ffmpeg', { skip: !PY ? 'python3 is not available' : !FFMPEG ? 'ffmpeg is not available' : false }, () => {
  for (const variant of [{ channels: 2 }, { bits: 8 }, { rate: 44100, channels: 2 }]) {
    const s = scratch();
    try {
      const r = run(importArgs(s, writeIn(s, 'in.wav', makeWav(4, variant))));
      assert.equal(r.status, 0, JSON.stringify(variant) + r.stderr);
      assert.equal(r.json.converted, true);
      const info = inspectWav(readFileSync(join(s.out, 'reference.wav')));
      assert.deepEqual({ channels: info.channels, bits: info.bits }, { channels: 1, bits: 16 });
      assert.ok(Math.abs(info.seconds - 4) < 0.1);
      assert.deepEqual(readdirSync(s.out), ['reference.wav']);
    } finally { s.close(); }
  }
});

test('import needing a conversion without ffmpeg fails cleanly (ffmpeg_missing) and writes nothing', opts, () => {
  const s = scratch();
  try {
    const r = run(importArgs(s, writeIn(s, 'in.wav', makeWav(4, { channels: 2 }))), { ...process.env, PATH: '' });
    assert.equal(r.status, 2); assert.equal(r.json.code, 'ffmpeg_missing');
    assert.equal(readdirSync(s.dir).includes('out') ? readdirSync(s.out).length : 0, 0);
  } finally { s.close(); }
});

test('import rejects non-WAV, too short, too long, oversize, non-PCM, missing files and bad transcripts, each with a code and no path', opts, () => {
  const s = scratch();
  try {
    const big = makeWav(4); big.writeUInt32LE(40 * 1024 * 1024, 40); // header claims 40 MB; the file below is padded past the 32 MiB bound
    const cases: Array<[string, string, string, string?]> = [
      ['not wav', writeIn(s, 'text.wav', Buffer.from('this is not audio, just text'.repeat(20))), 'not_wav'],
      ['too short', writeIn(s, 'short.wav', makeWav(2)), 'too_short'],
      ['too long', writeIn(s, 'long.wav', makeWav(31)), 'too_long'],
      ['oversize', writeIn(s, 'big.wav', Buffer.concat([big, Buffer.alloc(33 * 1024 * 1024)])), 'too_large'],
      ['float', writeIn(s, 'float.wav', makeWav(4, { format: 3, bits: 32 })), 'not_pcm'],
      ['missing', join(s.dir, 'nope.wav'), 'not_found'],
      ['directory', s.dir, 'not_found'],
      ['empty transcript', writeIn(s, 'ok.wav', makeWav(4)), 'bad_transcript', '   '],
      ['long transcript', join(s.dir, 'ok.wav'), 'bad_transcript', 'a'.repeat(501)],
    ];
    for (const [name, file, code, transcript] of cases) {
      const r = run(importArgs(s, file, transcript ?? 'Hola, esta es mi voz de prueba.'));
      assert.equal(r.status, 2, name); assert.equal(r.lines.length, 1, name);
      assert.deepEqual({ ok: r.json.ok, code: r.json.code }, { ok: false, code }, name);
      assert.equal(r.stdout.includes(s.dir), false, `${name}: no path echoed`);
    }
    assert.equal(readdirSync(s.dir).includes('out') ? readdirSync(s.out).length : 0, 0, 'nothing was written by any rejected import');
  } finally { s.close(); }
});

test('runVoiceScript passes the worker flags and parses the single JSON line; failures keep their code and drop paths', async () => {
  let seen: string[] = [];
  const ok = await runVoiceScript({ python: '/py', script: '/s.py', args: ['design', '--x'], run: async (_p, args) => { seen = args; return { code: 0, stdout: 'noise\n{"ok": true, "mode": "design", "seconds": 5.5}\n' }; } });
  assert.deepEqual(seen, ['-E', '-P', '/s.py', 'design', '--x']);
  assert.deepEqual(ok, { ok: true, result: { ok: true, mode: 'design', seconds: 5.5 } });
  const bad = await runVoiceScript({ python: '/py', script: '/s.py', args: [], run: async () => ({ code: 2, stdout: '{"ok": false, "code": "too_short", "message": "The WAV /Users/x/secret.wav is too short"}\n' }) });
  assert.deepEqual(bad, { ok: false, code: 'too_short', message: 'The WAV is too short' });
  assert.equal((await runVoiceScript({ python: '/py', script: '/s.py', args: [], run: async () => ({ code: 1, stdout: 'garbage' }) })).ok, false);
  assert.equal((await runVoiceScript({ python: '/py', script: '/s.py', args: [], run: async () => { throw new Error('boom'); } })).ok, false);
  const controller = new AbortController(); controller.abort();
  assert.equal((await runVoiceScript({ python: '/py', script: '/s.py', args: [], signal: controller.signal, run: async () => ({ code: null, stdout: '' }) })).ok, false);
});

test('T61: runVoiceScript runs Python in a fresh private directory (never process.cwd()), removed afterwards; defaultPythonRun honours the cwd it is given', async () => {
  const project = mkdtempSync(join(tmpdir(), 'gs-project-')), before = process.cwd();
  try {
    process.chdir(project);
    let seen: { cwd?: string; mode?: number } = {};
    const out = await runVoiceScript({ python: '/py', script: '/s.py', args: ['design'], run: async (_p, _a, o: any) => { seen = { cwd: o.cwd, mode: o.cwd && existsSync(o.cwd) ? statSync(o.cwd).mode & 0o777 : undefined }; return { code: 0, stdout: '{"ok": true}\n' }; } });
    assert.equal(out.ok, true);
    assert.equal(typeof seen.cwd, 'string'); assert.notEqual(seen.cwd, project); assert.notEqual(seen.cwd, realpathSync(project));
    assert.equal(seen.mode, 0o700); assert.equal(existsSync(seen.cwd!), false, 'removed after the run');
    const real = await defaultPythonRun(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { env: process.env, timeoutMs: 10_000, cwd: tmpdir() } as any);
    assert.equal(real.stdout, realpathSync(tmpdir()));
  } finally { process.chdir(before); rmSync(project, { recursive: true, force: true }); }
});
