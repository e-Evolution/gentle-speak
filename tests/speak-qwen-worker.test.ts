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
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { QWEN_PYTHON_FLAGS } from '../lib/speak-voices.ts';

const PYTHON = '/opt/homebrew/bin/python3.14';
const SCRIPT = resolve(import.meta.dirname, '../scripts/speak-qwen-worker.py');
const schema = 'gentle.speak.qwen/v1';
const skip = existsSync(PYTHON) ? false : `${PYTHON} is not installed`;

function start(env: Record<string, string> = {}) {
  const child = spawn(PYTHON, [...QWEN_PYTHON_FLAGS, SCRIPT], { env: { PATH: '/usr/bin:/bin', GENTLE_SPEAK_QWEN_FAKE: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: any[] = [];
  const stamps: number[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout }).on('line', line => { stamps.push(performance.now()); lines.push(JSON.parse(line)); waiters.splice(0).forEach(w => w()); });
  const until = async (predicate: (all: any[]) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate(lines)) {
      if (Date.now() > deadline) throw new Error(`timeout; got ${JSON.stringify(lines)}`);
      await new Promise<void>(resolveWait => { waiters.push(resolveWait); setTimeout(resolveWait, 100); });
    }
  };
  const send = (value: unknown) => child.stdin.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
  const exited = new Promise<number | null>(resolveExit => child.on('exit', code => resolveExit(code)));
  return { child, lines, stamps, until, send, exited };
}
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'speak-qwen-'));
  const ref = join(dir, 'ref.wav'); writeFileSync(ref, 'RIFF');
  const out = join(dir, 'out'); mkdirSync(out);
  return { dir, ref, out, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const synth = (s: ReturnType<typeof scratch>, over: any = {}) => ({ schema, type: 'synth', id: 7, text: 'Hola mundo.', ref: s.ref, refText: 'transcripcion', outDir: s.out, speed: 1, ...over });

test('fake worker emits ready, then in-order chunks and done for a synth request', { skip }, async () => {
  const s = scratch(); const w = start();
  try {
    await w.until(l => l.length >= 1);
    assert.deepEqual(w.lines[0], { schema, type: 'ready' });
    const long = Array.from({ length: 12 }, (_, i) => `Esta es la oración número ${i} con bastante relleno para superar el límite de grupo.`).join(' ');
    w.send(synth(s, { text: long }));
    await w.until(l => l.some(m => m.type === 'done'));
    const chunks = w.lines.filter(m => m.type === 'chunk');
    assert.ok(chunks.length >= 2, 'long text is split into several groups');
    assert.deepEqual(chunks.map(c => c.seq), chunks.map((_, i) => i));
    for (const c of chunks) {
      assert.equal(c.id, 7); assert.ok(c.seconds > 0);
      assert.ok(c.wav.startsWith(s.out + '/')); assert.equal(readFileSync(c.wav).subarray(0, 4).toString(), 'RIFF');
    }
    assert.deepEqual(w.lines.at(-1), { schema, type: 'done', id: 7 });
    assert.ok(w.lines.every(m => m.schema === schema), 'stdout carries only protocol lines');
    w.send({ schema, type: 'shutdown' });
    assert.equal(await w.exited, 0);
  } finally { w.child.kill(); s.close(); }
});

test('malformed or invalid requests produce error without crashing the worker', { skip }, async () => {
  const s = scratch(); const w = start();
  try {
    await w.until(l => l.length >= 1);
    w.send('not json');
    w.send({ schema, type: 'synth', id: 3, text: 'x' });
    w.send(synth(s, { id: 4, ref: 'relative.wav' }));
    w.send(synth(s, { id: 5, speed: 9 }));
    await w.until(l => l.filter(m => m.type === 'error').length === 4);
    const errors = w.lines.filter(m => m.type === 'error');
    assert.deepEqual(errors.map(e => e.id), [null, 3, 4, 5]);
    assert.ok(errors.every(e => typeof e.message === 'string' && e.message.length > 0));
    assert.equal(w.child.exitCode, null);
    w.send(synth(s, { id: 6 }));
    await w.until(l => l.some(m => m.type === 'done' && m.id === 6));
    assert.deepEqual(readdirSync(s.out).filter(f => f.startsWith('chunk-6')).length > 0, true);
    w.send({ schema, type: 'shutdown' });
    assert.equal(await w.exited, 0);
  } finally { w.child.kill(); s.close(); }
});

test('speed != 1 without ffmpeg warns exactly once and still plays at native speed', { skip }, async () => {
  const s = scratch(); const w = start({ PATH: '/nonexistent' });
  try {
    await w.until(l => l.length >= 1);
    w.send(synth(s, { id: 1, speed: 1.5 })); w.send(synth(s, { id: 2, speed: 1.5 }));
    await w.until(l => l.filter(m => m.type === 'done').length === 2);
    assert.equal(w.lines.filter(m => m.type === 'warning').length, 1);
    assert.match(w.lines.find(m => m.type === 'warning').message, /ffmpeg/);
    w.send({ schema, type: 'shutdown' }); await w.exited;
  } finally { w.child.kill(); s.close(); }
});

test('speed != 1 with ffmpeg shortens the chunk (pitch-preserving atempo)', { skip: skip || (existsSync('/opt/homebrew/bin/ffmpeg') ? false : 'ffmpeg is not installed') }, async () => {
  const s = scratch(); const w = start({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' });
  try {
    await w.until(l => l.length >= 1);
    w.send(synth(s, { id: 1, speed: 2 }));
    await w.until(l => l.some(m => m.type === 'done'));
    assert.ok(w.lines.find(m => m.type === 'chunk').seconds < 0.2, 'a 0.25 s chunk at 2x is about 0.125 s');
    assert.equal(w.lines.filter(m => m.type === 'warning').length, 0);
    w.send({ schema, type: 'shutdown' }); await w.exited;
  } finally { w.child.kill(); s.close(); }
});

test('fake-model worker sends each streamed part as its own chunk, in order, before the group finishes', { skip }, async () => {
  const s = scratch();
  const w = start({ GENTLE_SPEAK_QWEN_FAKE: '0', GENTLE_SPEAK_QWEN_FAKE_MODEL: '1', GENTLE_SPEAK_QWEN_FAKE_PARTS: '4', GENTLE_SPEAK_QWEN_FAKE_DELAY: '0.3' });
  try {
    await w.until(l => l.length >= 1);
    assert.deepEqual(w.lines[0], { schema, type: 'ready' });
    const sent = performance.now();
    w.send(synth(s, { text: 'Una sola frase corta.' })); // one group, four streamed parts of 0.3 s each
    await w.until(l => l.some(m => m.type === 'done'));
    const chunks = w.lines.filter(m => m.type === 'chunk');
    assert.equal(chunks.length, 4, 'one chunk per streamed part');
    assert.deepEqual(chunks.map(c => c.seq), [0, 1, 2, 3]);
    assert.deepEqual(w.lines.at(-1), { schema, type: 'done', id: 7 });
    assert.ok(w.lines.slice(0, -1).every(m => m.type === 'ready' || m.type === 'chunk'));
    const first = w.stamps[1] - sent, done = w.stamps.at(-1)! - sent;
    assert.ok(first < 800, `first chunk after the first part, not the group (${first.toFixed(0)} ms)`);
    assert.ok(done - first > 600, `later parts keep arriving after the first chunk (${(done - first).toFixed(0)} ms)`);
    for (const c of chunks) {
      assert.equal(readFileSync(c.wav).subarray(0, 4).toString(), 'RIFF');
      assert.equal(Math.round(c.seconds * 1000), 200, 'each part is its own 0.2 s PCM16 WAV');
    }
    assert.equal(readdirSync(s.out).filter(f => f.includes('.tmp') || f.includes('.tempo')).length, 0);
    w.send({ schema, type: 'shutdown' });
    assert.equal(await w.exited, 0);
  } finally { w.child.kill(); s.close(); }
});
