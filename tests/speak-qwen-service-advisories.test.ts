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
// T39 / S13: the T38 review advisories (CR text, idle exit, version ping-pong, blocking ps) plus preserve tests for T38 behavior.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createQwenSpeech } from '../lib/speak-qwen.ts';
import { compareQwenServiceVersions, connectQwenService } from '../lib/speak-qwen-service.ts';
import { createQwenServiceSpawner } from '../lib/speak-qwen-client.ts';
import { qwenFixture, rawClient, until } from './helpers/qwen-service-fixture.ts';

type Fx = ReturnType<typeof qwenFixture>;
const synth = (fx: Fx, id: number, text: string, outDir: string, priority = 'speak', extra: object = {}) =>
  ({ type: 'synth', id, priority, text, ref: fx.ref, refText: 'ref', outDir, speed: 1, ...extra });
async function client(fx: Fx, extra = {}) {
  const connection = await connectQwenService(fx.options(extra));
  connection.socket.setEncoding('utf8');
  return rawClient(connection.socket, connection.rest);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---- R3-ctrl-chars-reject-cr ------------------------------------------------------------------------------------------------------------
test('R3-ctrl-chars: CRLF, CR, tabs and form feeds are legitimate text: accepted and normalized; real control characters are still rejected', async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx); const dir = fx.outDir();
    c.send(synth(fx, 1, 'uno\r\ndos\rtres\tcuatro\u000bcinco\u000csiete', dir));
    await c.waitFor(m => m.some(x => x.id === 1 && (x.type === 'done' || x.type === 'error')), 'reply');
    assert.equal(c.ofId(1).at(-1).type, 'done', JSON.stringify(c.ofId(1)));
    assert.deepEqual(fx.read('order.log'), ['uno', 'dos', 'tres\tcuatro cinco siete'], 'Python saw LF line breaks only, no CR, VT or FF');
    for (const [id, text] of [[2, 'a\u0007b'], [3, 'a\u001b[31mb'], [4, 'a\u0000b'], [5, 'a\u007fb']] as const) {
      c.send(synth(fx, id, text, dir));
      await c.waitFor(m => m.some(x => x.id === id && x.type === 'error'), `reject ${id}`);
      assert.match(c.ofId(id)[0].message, /^invalid request: bad text$/);
    }
    assert.equal(fx.read('order.log').length, 3, 'rejected text never reached Python');
    c.send(synth(fx, 6, '\r\n \t', dir)); // whitespace only is still blank
    await c.waitFor(m => m.some(x => x.id === 6 && x.type === 'error'), 'blank');
    assert.match(c.ofId(6)[0].message, /bad text/);
  } finally { await fx.close(); }
});

test('R3-ctrl-chars: the client normalizes CR text before it reaches the service or a local worker', async () => {
  const fx = qwenFixture();
  try {
    const writes: any[] = [];
    const spawnLocal = () => {
      const child: any = Object.assign(new EventEmitter(), { stdin: { write: (l: string) => { writes.push(JSON.parse(l)); return true; }, end() {} }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } });
      return child;
    };
    const spawner = createQwenServiceSpawner({ ...fx.options(), spawnLocal, connect: async () => { throw new Error('no service'); } });
    const child = spawner(fx.options().python);
    child.stdin.write(JSON.stringify({ schema: 'gentle.speak.qwen/v1', type: 'synth', id: 1, text: 'a\r\nb\rc', ref: fx.ref, refText: 'r', outDir: fx.root, speed: 1 }) + '\n');
    await until(() => writes.length === 1, 'forwarded');
    assert.equal(writes[0].text, 'a\nb\nc');
    child.kill();
  } finally { await fx.close(); }
});

// ---- R3-exit-idle-doc-mismatch ----------------------------------------------------------------------------------------------------------
test('R3-exit-idle: with no --exit-idle-ms the service exits idleMs after the last request when nobody is connected (S13/L77)', async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx, { idleMs: 700, exitIdleMs: undefined });
    const service = fx.pidOf()!;
    c.send(synth(fx, 1, 'hola', fx.outDir()));
    await c.waitFor(m => m.some(x => x.type === 'done'));
    c.socket.destroy();
    const t0 = Date.now();
    await sleep(250);
    assert.equal(fx.isAlive(service), true, 'not before the idle timeout');
    await until(() => !fx.isAlive(service), 'service exited on the idle timeout', 6000);
    assert.ok(Date.now() - t0 < 4000, 'well before the old 30 minute exit');
    assert.equal(fx.workerPids().every(pid => !fx.isAlive(pid)), true);
  } finally { await fx.close(); }
});

test('R3-exit-idle: a connected client keeps the service up however long it is idle, and the grace starts when it leaves', async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx, { idleMs: 600, exitIdleMs: undefined });
    const service = fx.pidOf()!;
    for (let id = 1; id <= 3; id++) { c.send(synth(fx, id, `hola ${id}`, fx.outDir())); await c.waitFor(m => m.some(x => x.id === id && x.type === 'done')); await sleep(300); }
    assert.equal(fx.isAlive(service), true, 'requests every 300 ms keep a 600 ms service alive');
    await sleep(1200);
    assert.equal(fx.isAlive(service), true, 'an open connection keeps the service');
    c.socket.destroy();
    await until(() => !fx.isAlive(service), 'exit after the client left', 6000);
  } finally { await fx.close(); }
});

test('R3-exit-idle: with idle "never" the service does not exit on its own', async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx, { idleMs: null, exitIdleMs: undefined });
    const service = fx.pidOf()!;
    c.socket.destroy();
    await sleep(700);
    assert.equal(fx.isAlive(service), true);
  } finally { await fx.close(); }
});

// ---- R3-version-pingpong ------------------------------------------------------------------------------------------------------------------
test('R3-version: version ordering compares package version then protocol revision', () => {
  assert.equal(compareQwenServiceVersions('2.0.0+p1', '1.9.9+p1'), 1);
  assert.equal(compareQwenServiceVersions('1.0.0+p1', '1.0.1+p1'), -1);
  assert.equal(compareQwenServiceVersions('1.0.0+p2', '1.0.0+p1'), 1);
  assert.equal(compareQwenServiceVersions('1.10.0+p1', '1.9.0+p1'), 1);
  assert.equal(compareQwenServiceVersions('1.0.0+p1', '1.0.0+p1'), 0);
  assert.equal(compareQwenServiceVersions('old', '1.0.0+p1'), undefined);
});

test('R3-version: a newer client replaces an older service', async () => {
  const fx = qwenFixture();
  try {
    const old = await connectQwenService(fx.options({ version: '1.0.0+p1' })); old.socket.destroy();
    const fresh = await connectQwenService(fx.options({ version: '1.1.0+p1' }));
    assert.equal(fresh.version, '1.1.0+p1'); assert.notEqual(fresh.pid, old.pid);
    await until(() => !fx.isAlive(old.pid), 'old gone');
    fresh.socket.destroy();
  } finally { await fx.close(); }
});

test('R3-version: an older client never replaces a newer service; with a compatible protocol it uses it', async () => {
  const fx = qwenFixture();
  try {
    const newer = await connectQwenService(fx.options({ version: '2.0.0+p1' })); newer.socket.destroy();
    const used = await connectQwenService(fx.options({ version: '1.0.0+p1' }));
    assert.equal(used.pid, newer.pid, 'the same service');
    assert.equal(used.version, '2.0.0+p1');
    assert.equal(fx.isAlive(newer.pid), true, 'not asked to exit');
    // and the other one: ten alternations of both clients never restart anything
    for (let i = 0; i < 5; i++) {
      const a = await connectQwenService(fx.options({ version: '1.0.0+p1' })), b = await connectQwenService(fx.options({ version: '2.0.0+p1' }));
      assert.equal(a.pid, newer.pid); assert.equal(b.pid, newer.pid); a.socket.destroy(); b.socket.destroy();
    }
    assert.equal(fx.read('workers.log').length, 0);
    assert.equal(readFileSync(fx.paths.log, 'utf8').split('\n').filter(l => l.includes('listening on')).length, 1, 'one service ever started');
    used.socket.destroy();
  } finally { await fx.close(); }
});

test('R3-version: an older client with an incompatible protocol fails (so the session falls back to its local worker) without killing the service', async () => {
  const fx = qwenFixture();
  try {
    const newer = await connectQwenService(fx.options({ version: '2.0.0+p2' })); newer.socket.destroy();
    await assert.rejects(connectQwenService(fx.options({ version: '1.0.0+p1' })), /newer|incompatible/);
    assert.equal(fx.isAlive(newer.pid), true);
    assert.equal(fx.pidOf(), newer.pid);
    // through the session spawner this is a local worker, not a failure
    const reasons: string[] = []; let locals = 0;
    const spawnLocal = () => { locals++; return Object.assign(new EventEmitter(), { stdin: { write: () => true, end() {} }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }) as any; };
    const spawner = createQwenServiceSpawner({ ...fx.options({ version: '1.0.0+p1' }), spawnLocal, onFallback: r => reasons.push(r) });
    const child = spawner(fx.options().python);
    await until(() => locals === 1, 'local worker');
    assert.equal(reasons.length, 1); assert.equal(fx.isAlive(newer.pid), true);
    child.kill();
  } finally { await fx.close(); }
});

test('R3-version: restarts are rate-limited: two clients with different unordered versions do not take turns replacing the service', async () => {
  const fx = qwenFixture();
  try {
    const a = await connectQwenService(fx.options({ version: 'alpha' })); a.socket.destroy();
    const b = await connectQwenService(fx.options({ version: 'beta' })); b.socket.destroy(); // first replacement is allowed
    assert.notEqual(b.pid, a.pid);
    await assert.rejects(connectQwenService(fx.options({ version: 'alpha' })), /rate|recent|mismatch/i);
    assert.equal(fx.isAlive(b.pid), true, 'beta service not killed by the alpha client');
    const again = await connectQwenService(fx.options({ version: 'beta' }));
    assert.equal(again.pid, b.pid); again.socket.destroy();
  } finally { await fx.close(); }
});

// ---- R4-sync-ps-in-connect-loop ----------------------------------------------------------------------------------------------------------
test('R4-ps: the pid check does not block the event loop and runs at most once per attempt', async () => {
  const fx = qwenFixture();
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const psLog = join(fx.root, 'ps.log'), fakePs = join(fx.root, 'fake-ps');
    writeFileSync(fakePs, `#!/bin/sh\necho s >> "${psLog}"\nsleep 0.4\necho e >> "${psLog}"\necho "node qwen-service.mjs"\n`); chmodSync(fakePs, 0o755);
    writeFileSync(fx.paths.pid, String(sleeper.pid)); // a live pid that `ps` (fake) says is the service, with no socket: the loop waits and probes
    // R3-timing-assertions (T40): no wall-clock stall bound. Progress is what counts: the ticker must keep advancing WHILE a `ps` is in flight
    // (it sleeps 0.4 s; a blocked loop would see about 0 ticks in that window, a free one about 20; the floor of 3 holds on a loaded machine).
    let ticksDuringPs = 0;
    const inFlight = () => { try { const marks = readFileSync(psLog, 'utf8').split('\n').filter(Boolean); return marks.filter(m => m === 's').length > marks.filter(m => m === 'e').length; } catch { return false; } };
    const ticker = setInterval(() => { if (inFlight()) ticksDuringPs++; }, 20);
    const started = Date.now();
    try { await assert.rejects(connectQwenService(fx.options({ psPath: fakePs, timeoutMs: 1300 })), /did not answer in time/); } finally { clearInterval(ticker); }
    assert.ok(Date.now() - started >= 1200);
    assert.ok(ticksDuringPs >= 3, `the event loop advanced only ${ticksDuringPs} ticks while ps was running`);
    const calls = readFileSync(psLog, 'utf8').split('\n').filter(m => m === 's').length;
    assert.ok(calls >= 1 && calls <= 4, `ps ran ${calls} times in about 1.3 s of 450 ms attempts`);
  } finally { sleeper.kill(); await fx.close(); }
});

test('R4-ps: a hung ps is bounded and counted as not-ours, so a recycled pid is replaced', async () => {
  const fx = qwenFixture();
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const fakePs = join(fx.root, 'hung-ps');
    writeFileSync(fakePs, '#!/bin/sh\nexec sleep 30\n'); chmodSync(fakePs, 0o755);
    writeFileSync(fx.paths.pid, String(sleeper.pid));
    const started = Date.now();
    const connection = await connectQwenService(fx.options({ psPath: fakePs, psTimeoutMs: 300, timeoutMs: 8000 }));
    assert.ok(Date.now() - started < 5000);
    assert.notEqual(connection.pid, sleeper.pid); connection.socket.destroy();
  } finally { sleeper.kill(); await fx.close(); }
});

// ---- preserve (T38) ----------------------------------------------------------------------------------------------------------------------
test('preserve: a recycled pid (live, not the service) in the pid file is stale: the next client starts a service; same-version clients reuse it', async () => {
  const fx = qwenFixture();
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    writeFileSync(fx.paths.pid, String(sleeper.pid));
    const first = await connectQwenService(fx.options());
    const second = await connectQwenService(fx.options());
    assert.notEqual(first.pid, sleeper.pid); assert.equal(second.pid, first.pid);
    assert.equal(readFileSync(fx.paths.log, 'utf8').split('\n').filter(l => l.includes('listening on')).length, 1);
    first.socket.destroy(); second.socket.destroy();
  } finally { sleeper.kill(); await fx.close(); }
});

test('preserve: two sessions share one Python, speak outranks prepare, and the Python stays loaded while the sessions are connected (no idle close, T40)', async () => {
  const fx = qwenFixture();
  try {
    const a = await client(fx, { idleMs: 300 }), b = await client(fx, { idleMs: 300 }); const dir = fx.outDir();
    a.send(synth(fx, 1, 'slow uno', dir, 'prepare')); await until(() => fx.read('order.log').includes('slow uno'));
    a.send(synth(fx, 2, 'prepare dos', dir, 'prepare')); b.send(synth(fx, 1, 'speak b', dir, 'speak'));
    await b.waitFor(m => m.some(x => x.type === 'done')); await a.waitFor(m => m.filter(x => x.type === 'done').length === 2);
    assert.deepEqual(fx.read('order.log'), ['slow uno', 'speak b', 'prepare dos']);
    assert.equal(fx.workerPids().length, 1);
    const [py] = fx.workerPids();
    await sleep(900); // three times the old idle
    assert.equal(fx.isAlive(py), true, 'still loaded: both sessions are connected');
    b.send(synth(fx, 2, 'otra', dir)); await b.waitFor(m => m.some(x => x.id === 2 && x.type === 'done'));
    assert.equal(fx.workerPids().length, 1, 'served by the same Python');
  } finally { await fx.close(); }
});
