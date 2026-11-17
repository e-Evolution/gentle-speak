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
import { NO_UNIX_SOCKETS, UNIX_SOCKETS, assertMode } from './helpers/platform.ts';
// T38 / S13: the shared Qwen service. Real unix sockets and a real detached service process, in a temp shared home; the Python is a fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QWEN_PYTHON_FLAGS } from '../lib/speak-voices.ts';
import { qwenPythonEnv, spawnQwenPython, createQwenSpeech } from '../lib/speak-qwen.ts';
import { connectQwenService, qwenServiceVersion, spawnInHome } from '../lib/speak-qwen-service.ts';
import { createQwenServiceSpawner } from '../lib/speak-qwen-client.ts';
import { SERVICE_SCRIPT, qwenFixture, rawClient, until } from './helpers/qwen-service-fixture.ts';

const synth = (fx: ReturnType<typeof qwenFixture>, id: number, text: string, outDir: string, priority = 'speak', extra: object = {}) =>
  ({ type: 'synth', id, priority, text, ref: fx.ref, refText: 'ref', outDir, speed: 1, ...extra });
async function client(fx: ReturnType<typeof qwenFixture>, extra = {}) {
  const connection = await connectQwenService(fx.options(extra));
  connection.socket.setEncoding('utf8');
  return rawClient(connection.socket, connection.rest);
}

test('two clients share ONE Python worker and the model loads once', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const spawnLocal = () => { throw new Error('the local worker must not be used'); };
    const make = () => createQwenSpeech({ tmpRoot: fx.root, spawnPython: createQwenServiceSpawner({ ...fx.options(), spawnLocal }), spawnAudio: () => { throw new Error('no audio'); }, idleMs: null } as any);
    const a = make(), b = make();
    const base = { python: fx.options().python, ref: fx.ref, refText: 'ref', speed: 1 };
    const [ra, rb] = await Promise.all([a.prepare({ ...base, text: 'Hola uno.' }), b.prepare({ ...base, text: 'Hola dos.' })]);
    assert.equal(ra.ok, true); assert.equal(rb.ok, true);
    assert.equal(fx.workerPids().length, 1, 'one Python process for both sessions');
    assert.ok(ra.ok && rb.ok && ra.wavs[0] !== rb.wavs[0]);
    a.dispose(); b.dispose();
  } finally { await fx.close(); }
});

test('request isolation: equal ids on two connections never cross', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const a = await client(fx), b = await client(fx);
    const da = fx.outDir(), db = fx.outDir();
    a.send(synth(fx, 1, 'de a', da)); b.send(synth(fx, 1, 'de b', db));
    await a.waitFor(m => m.some(x => x.type === 'done'), 'a done'); await b.waitFor(m => m.some(x => x.type === 'done'), 'b done');
    assert.deepEqual(a.messages.filter(m => m.type === 'chunk').map(m => m.wav), [`${da}/chunk-${fx.read('order.log').indexOf('de a') + 1}-0.wav`]);
    assert.ok(a.messages.every(m => !JSON.stringify(m).includes(db)) && b.messages.every(m => !JSON.stringify(m).includes(da)));
    assert.equal(a.messages.filter(m => m.type === 'done').length, 1); assert.equal(b.messages.filter(m => m.type === 'done').length, 1);
    assert.equal(fx.workerPids().length, 1);
  } finally { await fx.close(); }
});

test('speak outranks queued prepares; a queued prepare can be cancelled; nothing is preempted', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx);
    const dir = fx.outDir();
    c.send(synth(fx, 1, 'slow first', dir, 'prepare'));
    await until(() => fx.read('order.log').includes('slow first'), 'first running');
    c.send(synth(fx, 2, 'prepare dos', dir, 'prepare'));
    c.send(synth(fx, 3, 'prepare tres', dir, 'prepare'));
    c.send(synth(fx, 4, 'speak cuatro', dir, 'speak'));
    c.send({ type: 'cancel', id: 3 });
    await c.waitFor(m => m.filter(x => x.type === 'done').length === 3, 'three done');
    assert.deepEqual(fx.read('order.log'), ['slow first', 'speak cuatro', 'prepare dos'], 'the running prepare finishes, then the speak, then the rest; the cancelled one never ran');
    assert.deepEqual(c.messages.filter(m => m.type === 'done').map(m => m.id), [1, 4, 2]);
    assert.equal(c.ofId(3).length, 0, 'a cancelled request gets no reply');
  } finally { await fx.close(); }
});

test('a running request that is cancelled finishes silently and the next one runs', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx); const dir = fx.outDir();
    c.send(synth(fx, 1, 'slow uno', dir)); await until(() => fx.read('order.log').includes('slow uno'));
    c.send(synth(fx, 2, 'siguiente', dir)); c.send({ type: 'cancel', id: 1 });
    await c.waitFor(m => m.some(x => x.id === 2 && x.type === 'done'), 'second done');
    assert.equal(c.ofId(1).length, 0);
  } finally { await fx.close(); }
});

test('a cancelled job whose outDir is gone is never sent to Python; it stays silent and the next job runs', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx, { env: { ...process.env, FW_DIR: fx.root, FW_READY_DELAY_MS: '300' } }); const gone = fx.outDir(), dir = fx.outDir();
    // The first job becomes the running one while Python is still loading, so a cancel cannot take it off the queue.
    c.send(synth(fx, 1, 'cancelado', gone)); c.send({ type: 'cancel', id: 1 });
    await until(() => fx.workerPids().length === 1, 'Python started, not ready yet');
    rmSync(gone, { recursive: true, force: true }); // what the client does after it cancels
    c.send(synth(fx, 2, 'siguiente', dir));
    await c.waitFor(m => m.some(x => x.id === 2 && x.type === 'done'), 'next done');
    assert.equal(c.ofId(1).length, 0, 'the cancelled job gets no reply');
    assert.deepEqual(fx.read('order.log'), ['siguiente'], 'the job whose outDir is gone never reached Python');
    assert.equal(fx.workerPids().length, 1, 'the worker was not disturbed');
    assert.doesNotMatch(readFileSync(fx.paths.log, 'utf8'), /ENOENT|outDir|request failed/, 'nothing is logged');
  } finally { await fx.close(); }
});

test('a queued job whose outDir is deleted while a slow job runs is skipped before Python, and the following job completes', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx); const dir = fx.outDir(), gone = fx.outDir();
    c.send(synth(fx, 1, 'slow uno', dir)); await until(() => fx.read('order.log').includes('slow uno'), 'slow running');
    c.send(synth(fx, 2, 'sin carpeta', gone)); c.send(synth(fx, 3, 'tercero', dir));
    await new Promise(r => setTimeout(r, 100)); // both are accepted and queued behind the slow one (400 ms)
    assert.equal(c.messages.filter(x => x.type === 'done' || x.type === 'error').length, 0, 'still queued');
    rmSync(gone, { recursive: true, force: true });
    await c.waitFor(m => m.some(x => x.id === 3 && x.type === 'done'), 'third done');
    assert.deepEqual(fx.read('order.log'), ['slow uno', 'tercero'], 'the job whose outDir is gone never reached Python');
    assert.deepEqual(c.ofId(2), [{ schema: 'gentle.speak.qwen-service/v1', type: 'error', id: 2, message: 'outDir removed' }], 'a job nobody cancelled still gets its one reply');
    assert.equal(fx.workerPids().length, 1, 'the worker was not disturbed');
  } finally { await fx.close(); }
});

test('a disconnected client drops its queued requests', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const a = await client(fx), b = await client(fx); const dir = fx.outDir();
    a.send(synth(fx, 1, 'slow a', dir)); await until(() => fx.read('order.log').includes('slow a'));
    b.send(synth(fx, 1, 'b queued', dir)); await new Promise(r => setTimeout(r, 50));
    b.socket.destroy();
    await a.waitFor(m => m.some(x => x.type === 'done'));
    await new Promise(r => setTimeout(r, 120));
    assert.deepEqual(fx.read('order.log'), ['slow a']);
  } finally { await fx.close(); }
});

test('validation: bad requests are rejected without reaching Python, and the connection keeps working', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx); const dir = fx.outDir();
    const bad: Array<[string, object]> = [
      ['ref outside the voices dir', { ref: '/etc/hosts' }],
      ['ref traversal', { ref: `${fx.home}/voices/qwen3/../../../etc/hosts` }],
      ['relative ref', { ref: 'voices/qwen3/ref.wav' }],
      ['oversize text', { text: 'x'.repeat(4001) }],
      ['blank text', { text: '   ' }],
      ['control chars', { text: 'a\u0007b' }],
      ['speed too high', { speed: 3 }],
      ['speed not a number', { speed: '1' }],
      ['bad priority', { priority: 'now' }],
      ['relative outDir', { outDir: 'out' }],
      ['unknown field', { extra: 1 }],
    ];
    let id = 10;
    for (const [what, patch] of bad) {
      const mine = id++;
      c.send({ ...synth(fx, mine, 'hola', dir), ...patch });
      await c.waitFor(m => m.some(x => x.id === mine && x.type === 'error'), what);
      assert.match(c.ofId(mine)[0].message, /^invalid request: /, what);
    }
    c.socket.write('not json\n');
    await c.waitFor(m => m.some(x => x.type === 'error' && x.id === null && /invalid JSON/.test(x.message)), 'json error');
    assert.equal(fx.workerPids().length, 0, 'no rejected request started Python');
    c.send(synth(fx, 99, 'hola', dir));
    await c.waitFor(m => m.some(x => x.id === 99 && x.type === 'done'), 'a valid one still works');
  } finally { await fx.close(); }
});

test('the home dir is 0700 and the socket 0600; a home owned by someone else is refused', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx);
    assert.equal(statSync(fx.home).mode & 0o777, 0o700);
    assert.equal(statSync(fx.paths.socket).mode & 0o777, 0o600);
    c.socket.destroy();
    await assert.rejects(connectQwenService(fx.options({ uid: (process.getuid?.() ?? 0) + 1 })), /not a directory owned by the current user/);
  } finally { await fx.close(); }
});

test('the start race: clients starting at once produce one service', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const all = await Promise.all([1, 2, 3, 4].map(() => connectQwenService(fx.options())));
    assert.equal(new Set(all.map(c => c.pid)).size, 1, 'every client reached the same service');
    assert.equal(fx.pidOf(), all[0].pid);
    assert.equal(readFileSync(fx.paths.log, 'utf8').split('\n').filter(l => l.includes('listening on')).length, 1, 'one service ever listened');
    all.forEach(c => c.socket.destroy());
    assert.equal(existsSync(fx.paths.lock), false, 'the start lock is released');
  } finally { await fx.close(); }
});

test('stale socket: a service killed hard leaves socket and pid; the next client cleans them and starts a new one', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const first = await connectQwenService(fx.options());
    first.socket.destroy();
    process.kill(first.pid, 'SIGKILL');
    await until(() => !fx.isAlive(first.pid), 'first service dead');
    assert.equal(existsSync(fx.paths.socket), true, 'the stale socket is still there');
    const second = await connectQwenService(fx.options());
    assert.notEqual(second.pid, first.pid);
    assert.equal(fx.pidOf(), second.pid);
    second.socket.destroy();
  } finally { await fx.close(); }
});

test('lifetime: the Python stays loaded while a client is connected; once the last one leaves the grace unloads it and the service exits, removing socket and pid', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx, { idleMs: 150, exitIdleMs: 500 });
    const service = fx.pidOf()!;
    c.send(synth(fx, 1, 'hola', fx.outDir()));
    await c.waitFor(m => m.some(x => x.type === 'done'));
    const [py] = fx.workerPids();
    assert.equal(fx.isAlive(py), true);
    await new Promise(r => setTimeout(r, 700)); // four times idleMs, 1.4 times the grace
    assert.equal(fx.isAlive(py), true, 'python stays loaded while a client is connected');
    assert.equal(fx.isAlive(service), true, 'the service stays while a client is connected');
    c.send(synth(fx, 2, 'otra', fx.outDir()));
    await c.waitFor(m => m.some(x => x.id === 2 && x.type === 'done'), 'served without a reload');
    assert.equal(fx.workerPids().length, 1);
    c.socket.destroy();
    await until(() => !fx.isAlive(service), 'service exit with no clients', 8000);
    assert.equal(fx.isAlive(py), false);
    assert.equal(existsSync(fx.paths.socket), false);
    assert.equal(existsSync(fx.paths.pid), false);
  } finally { await fx.close(); }
});

test('version mismatch: the old service is told to exit and a new one replaces it', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const old = await connectQwenService(fx.options({ version: 'old' }));
    old.socket.destroy();
    const fresh = await connectQwenService(fx.options({ version: 'new' }));
    assert.equal(fresh.version, 'new');
    assert.notEqual(fresh.pid, old.pid);
    await until(() => !fx.isAlive(old.pid), 'old service gone');
    fresh.socket.destroy();
  } finally { await fx.close(); }
});

test('version mismatch waits for the old queue to drain before it exits', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx, { version: 'old' });
    c.send(synth(fx, 1, 'slow vieja', fx.outDir()));
    await until(() => fx.read('order.log').includes('slow vieja'));
    const fresh = await connectQwenService(fx.options({ version: 'new' }));
    assert.equal(c.messages.some(m => m.id === 1 && m.type === 'done'), true, 'the running request finished before the replacement answered');
    assert.equal(fresh.version, 'new');
    fresh.socket.destroy();
  } finally { await fx.close(); }
});

test('fallback: when the service cannot start, the session gets a local worker, logged once, never a failure', async () => {
  const fx = qwenFixture();
  try {
    const reasons: string[] = [];
    const locals: any[] = [];
    const spawnLocal = () => {
      const writes: any[] = [];
      const child: any = Object.assign(new EventEmitter(), { stdin: { write: (l: string) => { writes.push(JSON.parse(l)); return true; }, end() {} }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } });
      locals.push({ child, writes }); return child;
    };
    const spawner = createQwenServiceSpawner({ ...fx.options({ serviceScript: '/nonexistent/service.mjs', timeoutMs: 4000 }), spawnLocal, onFallback: r => reasons.push(r) });
    const speech = createQwenSpeech({ tmpRoot: fx.root, spawnPython: spawner, spawnAudio: () => { throw new Error('no audio'); }, idleMs: null } as any);
    const first = speech.prepare({ python: fx.options().python, text: 'Hola.', ref: fx.ref, refText: 'ref', speed: 1 });
    await until(() => locals.length === 1 && locals[0].writes.length === 0, 'local worker spawned', 8000);
    locals[0].child.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak.qwen/v1', type: 'ready' }) + '\n');
    await until(() => locals[0].writes.length === 1, 'synth forwarded');
    const sent = locals[0].writes[0];
    assert.equal(sent.type, 'synth'); assert.equal('priority' in sent, false, 'a plain worker never sees the priority hint');
    locals[0].child.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak.qwen/v1', type: 'done', id: sent.id }) + '\n');
    // done without a chunk is still a settled prepare
    const outcome = await first;
    assert.equal(outcome.ok, true);
    assert.equal(reasons.length, 1, 'logged once');
    speech.dispose();
    const second = spawner(fx.options().python); second.kill();
    await new Promise(r => setTimeout(r, 300));
    assert.equal(reasons.length, 1, 'still once after another fallback');
    assert.equal(fx.workerPids().length, 0);
  } finally { await fx.close(); }
});

test('the service flags and env equal the per-session worker ones', () => {
  const source = readFileSync(SERVICE_SCRIPT, 'utf8');
  assert.deepEqual(JSON.parse(/PYTHON_FLAGS = (\[.*?\]);/.exec(source)![1].replaceAll("'", '"')), [...QWEN_PYTHON_FLAGS]);
  let seen: any;
  spawnQwenPython('/py', '/s.py', { spawn: ((_c: string, _a: string[], o: any) => { seen = o.env; return {} as any; }) as any, env: { A: '1' }, home: '/real' });
  assert.deepEqual(seen, qwenPythonEnv({ A: '1' }, '/real'));
  assert.equal(seen.HOME, '/real'); assert.equal(seen.HF_HOME, join('/real', '.cache', 'huggingface')); assert.match(qwenServiceVersion(), /^\d+\.\d+\.\d+\+p\d+$/);
});

test('T61: the shared service and its Python start in the private shared home, never in the caller\'s working directory', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  const project = mkdtempSync(join(tmpdir(), 'gsq-project-')), before = process.cwd();
  try {
    process.chdir(project);
    const c = await client(fx);
    process.chdir(before);
    c.send(synth(fx, 1, 'Hola.', fx.outDir()));
    await c.waitFor(m => m.some(x => x.type === 'done'), 'done');
    assert.deepEqual(fx.read('cwd.log'), [realpathSync(fx.home)]);
    assert.equal(statSync(fx.home).mode & 0o777, 0o700);
  } finally { process.chdir(before); await fx.close(); rmSync(project, { recursive: true, force: true }); }
});

test('T61: spawnInHome starts a child (the per-session Qwen worker) in the private home, whatever the caller\'s cwd; the home is created 0700', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gsq-home-')), home = join(root, '.gentle-speak'), before = process.cwd();
  try {
    process.chdir(root);
    const child = spawnInHome(home)(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { stdio: ['ignore', 'pipe', 'ignore'] });
    process.chdir(before);
    let out = ''; child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (d: string) => { out += d; });
    await new Promise(resolve => child.on('close', resolve));
    assert.equal(out, realpathSync(home)); assertMode(home, 0o700);
  } finally { process.chdir(before); rmSync(root, { recursive: true, force: true }); }
});
