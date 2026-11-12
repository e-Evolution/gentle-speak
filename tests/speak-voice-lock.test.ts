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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createVoiceLock } from '../lib/speak-voice-lock.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gs-lock-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const lockDir = (dir: string) => path.join(dir, 'voice.lock');

test('acquire creates a lock dir with an owner file (pid + timestamp) and release removes it', async () => {
  const dir = tmp();
  try {
    const lock = createVoiceLock({ dir, pollMs: 5, now: () => 1234 });
    await lock.acquire();
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir(dir), 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.at, 1234);
    await lock.release();
    assert.equal(fs.existsSync(lockDir(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two waiting acquirers never overlap and each gets a whole turn', async () => {
  const dir = tmp();
  try {
    const a = createVoiceLock({ dir, pollMs: 5 });
    const b = createVoiceLock({ dir, pollMs: 5 });
    const c = createVoiceLock({ dir, pollMs: 5 });
    const log: string[] = [];
    let inside = 0;
    const run = async (name: string, l: ReturnType<typeof createVoiceLock>, ms: number) => {
      await l.acquire();
      inside++;
      assert.equal(inside, 1);
      log.push(`in:${name}`);
      await sleep(ms);
      log.push(`out:${name}`);
      inside--;
      await l.release();
    };
    await a.acquire();
    const pb = run('b', b, 10);
    await sleep(15);
    const pc = run('c', c, 5);
    await sleep(15);
    assert.deepEqual(log, []);
    await a.release();
    await Promise.all([pb, pc]);
    // Cross-instance order is poll-race (FIFO-ish), so assert whole turns, not who goes first.
    assert.ok(['in:b,out:b,in:c,out:c', 'in:c,out:c,in:b,out:b'].includes(log.join(',')), log.join(','));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the same instance queues concurrent acquires', async () => {
  const dir = tmp();
  try {
    const l = createVoiceLock({ dir, pollMs: 5 });
    await l.acquire();
    let second = false;
    const p = l.acquire().then(() => { second = true; });
    await sleep(25);
    assert.equal(second, false);
    await l.release();
    await p;
    assert.equal(second, true);
    await l.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('abort while waiting rejects, and the abandoned waiter never takes the lock', async () => {
  const dir = tmp();
  try {
    const a = createVoiceLock({ dir, pollMs: 5 });
    const b = createVoiceLock({ dir, pollMs: 5 });
    await a.acquire();
    const ac = new AbortController();
    const p = b.acquire({ signal: ac.signal });
    await sleep(15);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    await a.release();
    await sleep(20);
    assert.equal(fs.existsSync(lockDir(dir)), false);
    await assert.rejects(b.acquire({ signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(fs.existsSync(lockDir(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a lock whose owner pid is dead is reclaimed; a live owner is respected', async () => {
  const dir = tmp();
  try {
    fs.mkdirSync(lockDir(dir), { recursive: true });
    fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), JSON.stringify({ pid: 999999, at: Date.now(), token: 'other' }));
    const checked: number[] = [];
    const lock = createVoiceLock({ dir, pollMs: 5, isPidAlive: pid => { checked.push(pid); return false; } });
    await lock.acquire();
    assert.ok(checked.length >= 1 && checked.every(pid => pid === 999999)); // checked again after the rename
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir(dir), 'owner.json'), 'utf8')).pid, process.pid);
    await lock.release();

    fs.mkdirSync(lockDir(dir));
    fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), JSON.stringify({ pid: 4242, at: Date.now(), token: 'other' }));
    const waiter = createVoiceLock({ dir, pollMs: 5, isPidAlive: () => true });
    const ac = new AbortController();
    const p = waiter.acquire({ signal: ac.signal });
    await sleep(30);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir(dir), 'owner.json'), 'utf8')).pid, 4242);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('release never removes a lock this instance does not own', async () => {
  const dir = tmp();
  try {
    const lock = createVoiceLock({ dir, pollMs: 5 });
    await lock.release(); // never acquired, nothing there
    fs.mkdirSync(lockDir(dir));
    fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), JSON.stringify({ pid: 4242, at: Date.now(), token: 'other' }));
    await lock.release();
    assert.equal(fs.existsSync(path.join(lockDir(dir), 'owner.json')), true);
    // Owned once, then reclaimed by someone else as stale: our release must not delete theirs.
    fs.rmSync(lockDir(dir), { recursive: true });
    await lock.acquire();
    fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'someone-else' }));
    await lock.release();
    assert.equal(fs.existsSync(path.join(lockDir(dir), 'owner.json')), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('half-written or unreadable owner file: respected within the grace period, stale after it', async () => {
  const dir = tmp();
  try {
    fs.mkdirSync(lockDir(dir));
    fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), '{"pid":');
    const lock = createVoiceLock({ dir, pollMs: 5, graceMs: 60_000 });
    const ac = new AbortController();
    const p = lock.acquire({ signal: ac.signal });
    await sleep(30);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir(dir), old, old);
    await lock.acquire();
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir(dir), 'owner.json'), 'utf8')).pid, process.pid);
    await lock.release();

    fs.mkdirSync(lockDir(dir)); // no owner file at all, old dir
    fs.utimesSync(lockDir(dir), old, old);
    await lock.acquire();
    await lock.release();
    assert.equal(fs.existsSync(lockDir(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const writeOwner = (dir: string, owner: object) => { fs.mkdirSync(lockDir(dir), { recursive: true }); fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), JSON.stringify(owner)); };
const ownerOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(lockDir(dir), 'owner.json'), 'utf8'));

test('release does not delete a lock another owner took between the check and the removal', async () => {
  const dir = tmp();
  try {
    const lock = createVoiceLock({ dir, pollMs: 5, hooks: { beforeAct: kind => {
      if (kind !== 'release') return;
      fs.rmSync(lockDir(dir), { recursive: true });
      writeOwner(dir, { pid: 4242, at: Date.now(), token: 'live-other' });
    } } });
    await lock.acquire();
    await lock.release();
    assert.equal(ownerOf(dir).token, 'live-other');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['voice.lock']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stale reclaim does not delete a live lock that replaced the stale one before the rename', async () => {
  const dir = tmp();
  try {
    writeOwner(dir, { pid: 999999, at: 1, token: 'dead' });
    let swapped = false;
    const lock = createVoiceLock({ dir, pollMs: 5, isPidAlive: pid => pid === 4242, hooks: { beforeAct: kind => {
      if (kind !== 'reclaim' || swapped) return;
      swapped = true;
      fs.rmSync(lockDir(dir), { recursive: true });
      writeOwner(dir, { pid: 4242, at: Date.now(), token: 'live-other' });
    } } });
    const ac = new AbortController();
    const p = lock.acquire({ signal: ac.signal });
    await sleep(40);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(ownerOf(dir).token, 'live-other');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['voice.lock']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** Records every fs call that removes or moves something, to prove who touches the lock path. */
function spyDestructive() {
  const calls: Array<{ op: string; args: string[] }> = [];
  const originals: Record<string, any> = {};
  for (const op of ['renameSync', 'rmSync', 'rmdirSync', 'unlinkSync']) {
    originals[op] = (fs as any)[op];
    (fs as any)[op] = (...args: any[]) => { calls.push({ op, args: args.filter(a => typeof a === 'string') }); return originals[op](...args); };
  }
  return { calls, restore: () => { for (const op of Object.keys(originals)) (fs as any)[op] = originals[op]; } };
}
const touchesLock = (calls: Array<{ args: string[] }>, dir: string) => calls.filter(c => c.args.some(a => a === lockDir(dir)));

test('owner release never renames the lock path, so there is no window in which it is absent', async () => {
  const dir = tmp();
  const spy = spyDestructive();
  try {
    const lock = createVoiceLock({ dir, pollMs: 5 });
    await lock.acquire();
    spy.calls.length = 0;
    await lock.release();
    assert.deepEqual(spy.calls.filter(c => c.op === 'renameSync'), []);
    assert.equal(fs.existsSync(lockDir(dir)), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { spy.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a waiter on a live owner never renames or removes the lock path', async () => {
  const dir = tmp();
  const spy = spyDestructive();
  try {
    writeOwner(dir, { pid: 4242, at: Date.now(), token: 'live-other' });
    const waiter = createVoiceLock({ dir, pollMs: 2, isPidAlive: () => true });
    const ac = new AbortController();
    const p = waiter.acquire({ signal: ac.signal });
    await sleep(40);
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.deepEqual(touchesLock(spy.calls, dir), []);
    assert.equal(ownerOf(dir).token, 'live-other');
  } finally { spy.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stale reclaim holds a separate voice.reclaim mutex while it removes the lock, and releases it afterwards', async () => {
  const dir = tmp();
  try {
    writeOwner(dir, { pid: 999999, at: 1, token: 'dead' });
    let mutexSeenDuringReclaim = false;
    const lock = createVoiceLock({ dir, pollMs: 2, isPidAlive: () => false, hooks: { beforeAct: kind => { if (kind === 'reclaim') mutexSeenDuringReclaim = fs.existsSync(path.join(dir, 'voice.reclaim')); } } });
    await lock.acquire();
    assert.equal(mutexSeenDuringReclaim, true);
    assert.equal(fs.existsSync(path.join(dir, 'voice.reclaim')), false);
    assert.equal(ownerOf(dir).pid, process.pid);
    await lock.release();
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('close(): rejects a pending acquire, releases a held lock exactly once and refuses later acquires', async () => {
  const dir = tmp();
  try {
    const owner = createVoiceLock({ dir, pollMs: 2 });
    const waiter = createVoiceLock({ dir, pollMs: 2 });
    await owner.acquire();
    const pending = waiter.acquire();
    const settled = pending.then(() => 'taken', e => e.name);
    await sleep(15);
    waiter.close();
    assert.equal(await settled, 'AbortError');
    owner.close();
    assert.equal(fs.existsSync(lockDir(dir)), false);
    // A foreign lock taken after our close() must not be removed by a second close() or release().
    writeOwner(dir, { pid: 4242, at: Date.now(), token: 'live-other' });
    owner.close();
    await owner.release();
    assert.equal(ownerOf(dir).token, 'live-other');
    await assert.rejects(owner.acquire(), { name: 'AbortError' });
    await assert.rejects(waiter.acquire(), { name: 'AbortError' });
    fs.rmSync(lockDir(dir), { recursive: true });
    await sleep(15);
    assert.equal(fs.existsSync(lockDir(dir)), false, 'nothing is acquired after close');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('close() while the acquire is already waiting for the lock to free never leaves it held', async () => {
  const dir = tmp();
  try {
    const owner = createVoiceLock({ dir, pollMs: 2 });
    const waiter = createVoiceLock({ dir, pollMs: 2 });
    await owner.acquire();
    const settled = waiter.acquire().then(() => 'taken', e => e.name);
    await sleep(10);
    await owner.release();
    waiter.close(); // same tick as the owner letting go: the waiter may already have its mkdir in flight
    const outcome = await settled;
    await sleep(15);
    assert.equal(fs.existsSync(lockDir(dir)), false, `outcome ${outcome}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no raw fs error escapes acquire: a transient race error polls again, anything else rejects as VoiceLockError', async () => {
  const dir = tmp();
  const original = fs.writeFileSync;
  try {
    let fail: string | undefined = 'EINVAL';
    (fs as any).writeFileSync = (...args: any[]) => {
      if (fail && String(args[0]).endsWith('owner.json')) { const code = fail; fail = undefined; throw Object.assign(new Error(code), { code }); }
      return (original as any)(...args);
    };
    const lock = createVoiceLock({ dir, pollMs: 2 });
    await lock.acquire();
    assert.equal(ownerOf(dir).pid, process.pid, 'EINVAL meant poll again, then the lock was taken');
    await lock.release();
    assert.deepEqual(fs.readdirSync(dir), [], 'no temp dir left behind');

    (fs as any).writeFileSync = (...args: any[]) => {
      if (String(args[0]).endsWith('owner.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return (original as any)(...args);
    };
    await assert.rejects(createVoiceLock({ dir, pollMs: 2 }).acquire(), (e: any) => e.name === 'VoiceLockError' && e.cause?.code === 'EACCES');
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { (fs as any).writeFileSync = original; fs.rmSync(dir, { recursive: true, force: true }); }
});
