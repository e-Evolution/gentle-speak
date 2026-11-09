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
    assert.deepEqual(checked, [999999]);
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
