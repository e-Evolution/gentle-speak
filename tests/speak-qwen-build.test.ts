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
// T50 / S13 (L98): the service build id. A content hash of the service and worker scripts rides in the handshake, so any code change replaces a running service.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { copyFileSync, appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as service from '../lib/speak-qwen-service.ts';
import { ensurePrivateHome, qwenServicePaths, qwenServiceVersion, connectQwenService } from '../lib/speak-qwen-service.ts';
import { SERVICE_SCRIPT, qwenFixture, rawClient, until } from './helpers/qwen-service-fixture.ts';

const buildId = (a: string, b: string): string | undefined => (service as any).qwenBuildId?.(a, b);
/** A copy of the fixture's worker with different bytes: same package version and protocol, another build. */
const variant = (fx: ReturnType<typeof qwenFixture>, name: string) => { const path = join(fx.root, name); copyFileSync(fx.options().script, path); appendFileSync(path, `\n// ${name}\n`); return path; };

test('T50: the build id is 12 hex chars, deterministic, and changes with either script\'s bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gsq-build-'));
  try {
    const svc = join(dir, 's.mjs'), wrk = join(dir, 'w.py');
    writeFileSync(svc, 'service'); writeFileSync(wrk, 'worker');
    const first = buildId(svc, wrk);
    assert.match(first ?? '', /^[0-9a-f]{12}$/);
    assert.equal(buildId(svc, wrk), first);
    writeFileSync(wrk, 'worker!');
    const afterWorker = buildId(svc, wrk);
    assert.notEqual(afterWorker, first);
    writeFileSync(svc, 'service!');
    assert.notEqual(buildId(svc, wrk), afterWorker);
    assert.notEqual(buildId(svc, wrk), first);
    assert.equal(buildId(join(dir, 'missing'), wrk), undefined, 'an unreadable script gives no build id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('T50: the service reports the same build id the client computes (service script + its worker script)', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const connection = await connectQwenService(fx.options());
    assert.equal((connection as any).build, buildId(SERVICE_SCRIPT, fx.options().script));
    assert.match((connection as any).build ?? '', /^[0-9a-f]{12}$/);
    assert.equal(connection.version, qwenServiceVersion(), 'the handshake version is unchanged');
    connection.socket.destroy();
  } finally { await fx.close(); }
});

test('T50: a same-version, different-build service is replaced', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const old = await connectQwenService(fx.options()); old.socket.destroy();
    const fresh = await connectQwenService(fx.options({ script: variant(fx, 'w2.mjs') }));
    assert.notEqual(fresh.pid, old.pid);
    assert.equal(fresh.version, old.version);
    assert.notEqual((fresh as any).build, (old as any).build);
    await until(() => !fx.isAlive(old.pid), 'old service gone');
    fresh.socket.destroy();
  } finally { await fx.close(); }
});

test('T50: a service whose hello has no build field (pre-T50) counts as a different build and is replaced', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  const paths = qwenServicePaths(fx.home);
  ensurePrivateHome(fx.home);
  let shutdowns = 0;
  const sockets = new Set<net.Socket>();
  const fake = net.createServer(socket => {
    sockets.add(socket); socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.write(JSON.stringify({ schema: 'gentle.speak.qwen-service/v1', type: 'hello', version: qwenServiceVersion(), pid: process.pid }) + '\n');
    socket.on('data', (chunk: string) => { if (chunk.includes('"shutdown"')) { shutdowns++; fake.close(); for (const s of sockets) s.destroy(); } });
  });
  try {
    await new Promise<void>(resolve => fake.listen(paths.socket, resolve));
    const fresh = await connectQwenService(fx.options());
    assert.equal(shutdowns, 1, 'the old service was asked to exit');
    assert.notEqual(fresh.pid, process.pid);
    assert.match((fresh as any).build ?? '', /^[0-9a-f]{12}$/);
    fresh.socket.destroy();
  } finally { fake.close(); for (const s of sockets) s.destroy(); await fx.close(); }
});

test('T50: the same build is reused: no restart, same pid, no restart stamp', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const a = await connectQwenService(fx.options());
    const b = await connectQwenService(fx.options());
    assert.equal(b.pid, a.pid);
    assert.equal(fx.isAlive(a.pid), true);
    assert.throws(() => readFileSync(fx.paths.restart), 'nobody stamped a replacement');
    a.socket.destroy(); b.socket.destroy();
  } finally { await fx.close(); }
});

test('T50: the 30 s restart rate limit stops two builds from ping-ponging', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const scriptB = variant(fx, 'wb.mjs');
    const a = await connectQwenService(fx.options()); a.socket.destroy();
    const b = await connectQwenService(fx.options({ script: scriptB })); // the first replacement is allowed
    assert.notEqual(b.pid, a.pid);
    for (let i = 0; i < 3; i++) {
      const again = await connectQwenService(fx.options()); // build A client, inside the window: it uses B's service instead of replacing it
      assert.equal(again.pid, b.pid);
      assert.equal(fx.isAlive(b.pid), true, 'B service not killed by the A client');
      again.socket.destroy();
    }
    b.socket.destroy();
  } finally { await fx.close(); }
});

test('T50: a replacement lets the old service finish every request already queued on it', { skip: !UNIX_SOCKETS && NO_UNIX_SOCKETS }, async () => {
  const fx = qwenFixture();
  try {
    const connection = await connectQwenService(fx.options());
    connection.socket.setEncoding('utf8');
    const c = rawClient(connection.socket, connection.rest);
    const out = fx.outDir();
    const req = (id: number, text: string) => ({ type: 'synth', id, priority: 'speak', text, ref: fx.ref, refText: 'ref', outDir: out, speed: 1 });
    c.send(req(1, 'slow vieja')); c.send(req(2, 'cola vieja'));
    await until(() => fx.read('order.log').includes('slow vieja'));
    const fresh = await connectQwenService(fx.options({ script: variant(fx, 'w3.mjs') }));
    assert.equal(c.messages.some(m => m.id === 1 && m.type === 'done'), true, 'the running request was not killed');
    assert.equal(c.messages.some(m => m.id === 2 && m.type === 'done'), true, 'the queued request finished too');
    assert.notEqual(fresh.pid, connection.pid);
    fresh.socket.destroy();
  } finally { await fx.close(); }
});
