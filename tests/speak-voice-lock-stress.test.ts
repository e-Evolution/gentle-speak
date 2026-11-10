import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createVoiceLock } from '../lib/speak-voice-lock.ts';

// S9 "never overlap": REAL separate node processes against one temp lock dir. No audio, no herdr.
const child = path.resolve(import.meta.dirname, 'helpers/lock-child.ts');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gs-lock-stress-'));
const lockDir = (dir: string) => path.join(dir, 'voice.lock');

/** A pid that is certainly dead: a child that already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

interface Run { code: number | null; stderr: string; pid: number }
const runChild = (args: string[]) => new Promise<Run>(resolve => {
  const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', child, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  c.stderr.on('data', d => { stderr += d; });
  c.on('close', code => resolve({ code, stderr, pid: c.pid! }));
});

function intervals(log: string) {
  const open = new Map<string, bigint>();
  const out: Array<{ id: string; start: bigint; end: bigint }> = [];
  for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const [kind, id, t] = line.split(' ');
    if (kind === 'S') open.set(id, BigInt(t));
    else out.push({ id, start: open.get(id)!, end: BigInt(t) });
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1));
}
const overlaps = (list: ReturnType<typeof intervals>) => list.filter((x, i) => i > 0 && x.start < list[i - 1].end).length;

async function round(dir: string, procs: number, iterations: number, holdMs: number) {
  const log = path.join(dir, 'log.txt');
  fs.writeFileSync(log, '');
  const startAt = String(Date.now() + 400);
  const runs = await Promise.all(Array.from({ length: procs }, (_, i) => runChild([dir, log, startAt, String(iterations), String(holdMs), String(i)])));
  return { runs, list: intervals(log) };
}

test('stress (a): 6 processes x 20 acquire/hold/release iterations never overlap', { timeout: 60_000 }, async () => {
  const dir = tmp();
  try {
    const { runs, list } = await round(dir, 6, 20, 1);
    assert.equal(new Set(runs.map(r => r.pid)).size, 6, 'separate pids');
    assert.deepEqual(runs.map(r => [r.code, r.stderr]), runs.map(() => [0, '']));
    assert.equal(list.length, 120);
    assert.equal(overlaps(list), 0);
    assert.equal(fs.existsSync(lockDir(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stress (b): 6 waiters racing to reclaim one dead-owner lock, 25 runs: 0 overlaps, 0 uncaught errors', { timeout: 120_000 }, async () => {
  const dir = tmp();
  const totals = { runs: 0, starts: 0, overlaps: 0, crashed: 0, leftover: 0, errors: [] as string[] };
  try {
    for (let n = 0; n < 25; n++) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(lockDir(dir), { recursive: true });
      fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), JSON.stringify({ pid: deadPid(), at: Date.now(), token: 'dead' }));
      const { runs, list } = await round(dir, 6, 1, 3);
      totals.runs++;
      totals.starts += list.length;
      totals.overlaps += overlaps(list);
      for (const r of runs) if (r.code !== 0 || r.stderr) { totals.crashed++; totals.errors.push(`run ${n}: ${(r.stderr.match(/Error: [^\n]*/) ?? [r.stderr.slice(0, 120)])[0]}`); }
      if (fs.existsSync(lockDir(dir))) totals.leftover++;
    }
    // Aggregate first, so a failure reports how often each symptom appeared across all 25 runs.
    assert.deepEqual({ ...totals, errors: totals.errors.slice(0, 5) }, { runs: 25, starts: 150, overlaps: 0, crashed: 0, leftover: 0, errors: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stress (c): a reclaim mutex left behind by a crashed reclaimer is recovered; a live one is respected', async () => {
  const dir = tmp();
  try {
    const dead = deadPid();
    fs.mkdirSync(lockDir(dir), { recursive: true });
    fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), JSON.stringify({ pid: dead, at: 1, token: 'dead' }));
    const mutex = path.join(dir, 'voice.reclaim');
    fs.mkdirSync(mutex);
    fs.writeFileSync(path.join(mutex, 'owner.json'), JSON.stringify({ pid: dead, at: 1, token: 'dead-reclaimer' }));
    const lock = createVoiceLock({ dir, pollMs: 2, reclaimGraceMs: 20 });
    await lock.acquire();
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir(dir), 'owner.json'), 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(mutex), false, 'stale mutex removed');
    await lock.release();

    // Live reclaimer: its mutex is respected, the dead-owner lock is not touched while it holds the mutex.
    fs.mkdirSync(lockDir(dir), { recursive: true });
    fs.writeFileSync(path.join(lockDir(dir), 'owner.json'), JSON.stringify({ pid: dead, at: 1, token: 'dead' }));
    fs.mkdirSync(mutex);
    fs.writeFileSync(path.join(mutex, 'owner.json'), JSON.stringify({ pid: 4242, at: Date.now(), token: 'live-reclaimer' }));
    const waiter = createVoiceLock({ dir, pollMs: 2, reclaimGraceMs: 20, isPidAlive: pid => pid === 4242 });
    const ac = new AbortController();
    const p = waiter.acquire({ signal: ac.signal });
    await new Promise(r => setTimeout(r, 80));
    ac.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir(dir), 'owner.json'), 'utf8')).token, 'dead');
    assert.equal(fs.existsSync(mutex), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
