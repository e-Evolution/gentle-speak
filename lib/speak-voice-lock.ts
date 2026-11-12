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
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * S9 single voice: a cross-process lock under `<dir>`.
 *
 * - `voice.lock/` is installed whole: a private temp dir holding `owner.json` (`{ pid, at, token }`) and a
 *   `token-<token>` marker is renamed into place, so the lock never exists without its owner file.
 * - Only the owner releases its lock, and it never renames the lock path: it checks its token in `owner.json`, then
 *   removes its own marker (gone means the lock is no longer ours), then `owner.json`, then `rmdir` (which fails,
 *   harmlessly, if a newcomer already replaced the emptied dir).
 * - A non-owner touches the lock path only to reclaim a stale lock (owner pid dead, or owner file missing or
 *   unreadable and the dir older than `graceMs`), and only while holding the separate `voice.reclaim/` mutex. Under
 *   the mutex it re-verifies staleness, renames the lock aside and deletes what it moved only when it is the same
 *   lock it judged stale; anything else is put back.
 * - A reclaim mutex whose holder pid is dead (or whose owner file is unreadable) is recovered once it is older than
 *   `reclaimGraceMs`.
 * - `acquire` never rejects with a raw fs error: races (ENOENT, EEXIST, ENOTEMPTY, EINVAL, EBUSY) mean "poll again";
 *   anything else rejects with a `VoiceLockError` carrying the cause.
 */
export interface VoiceLockOptions {
  dir: string;
  pollMs?: number;
  graceMs?: number;
  reclaimGraceMs?: number;
  now?: () => number;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  /** Test seams: `beforeAct` runs right before a destructive step (between check and act); `onWait` before each poll wait. */
  hooks?: { beforeAct?: (kind: 'release' | 'reclaim') => void; onWait?: () => void };
}

export interface AcquireOptions { signal?: AbortSignal }

export interface VoiceLock {
  acquire(opts?: AcquireOptions): Promise<void>;
  release(): Promise<void>;
  /** Permanent: rejects pending acquires, releases a held lock once, and makes later acquires reject. */
  close(): void;
}

export const defaultIsPidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code !== 'ESRCH'; }
};

const abortError = () => Object.assign(new Error('voice lock acquire aborted'), { name: 'AbortError' });
const lockError = (cause: unknown) => Object.assign(new Error('voice lock unavailable', { cause }), { name: 'VoiceLockError' });
const TRANSIENT = new Set(['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EINVAL', 'EBUSY']);
const isTransient = (e: any) => TRANSIENT.has(e?.code);
const taken = (e: any) => e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST';

interface Owner { pid: number; at?: number; token?: string }

export function createVoiceLock(opts: VoiceLockOptions): VoiceLock {
  const pollMs = opts.pollMs ?? 100;
  const graceMs = opts.graceMs ?? 5000;
  const reclaimGraceMs = opts.reclaimGraceMs ?? 500;
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const lockPath = path.join(opts.dir, 'voice.lock');
  const mutexPath = path.join(opts.dir, 'voice.reclaim');
  const token = randomUUID();
  const marker = path.join(lockPath, `token-${token}`);
  let held = false;
  let closed = false;
  const closer = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();

  const readOwner = (dir: string): Owner | undefined => {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
      return o && Number.isInteger(o.pid) ? o : undefined;
    } catch { return undefined; }
  };
  /** Identity of one dir object, so a reclaim deletes only the very lock it judged stale. */
  const identity = (dir: string): string | undefined => {
    try {
      const st = fs.statSync(dir);
      const o = readOwner(dir);
      return `${st.ino}:${st.birthtimeMs}:${o?.pid ?? ''}:${o?.token ?? ''}`;
    } catch { return undefined; }
  };
  /** Stale: owner pid dead, or no readable owner and older than `grace`. Unknown (vanished) is not stale. */
  const isStale = (dir: string, grace: number, requireAge: boolean): boolean => {
    let age: number;
    try { age = now() - fs.statSync(dir).mtimeMs; } catch { return false; }
    const owner = readOwner(dir);
    if (owner) return !isAlive(owner.pid) && (!requireAge || age > grace);
    return age > grace;
  };

  /** Installs `target` atomically from a private temp dir. False when somebody else holds it. */
  const install = (target: string, ownerToken: string, withMarker: boolean): boolean => {
    const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    let moved = false;
    try {
      fs.mkdirSync(tmp);
      fs.writeFileSync(path.join(tmp, 'owner.json'), JSON.stringify({ pid, at: now(), token: ownerToken }));
      if (withMarker) fs.writeFileSync(path.join(tmp, `token-${ownerToken}`), '');
      fs.renameSync(tmp, target);
      moved = true;
      return true;
    } catch (e) {
      if (taken(e)) return false;
      throw e;
    } finally {
      if (!moved) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  };
  /** Renames `target` aside and deletes it only when it is still the object identified as stale; otherwise puts it back. */
  const removeIfSame = (target: string, judged: string) => {
    const trash = `${target}.stale-${process.pid}-${randomUUID()}`;
    try { fs.renameSync(target, trash); } catch { return; }
    if (identity(trash) === judged) { fs.rmSync(trash, { recursive: true, force: true }); return; }
    try { fs.renameSync(trash, target); } catch { /* retaken meanwhile: leave it aside, never delete a live owner's data */ }
  };

  const mutexToken = randomUUID();
  /** Takes the reclaim mutex, recovering one left behind by a dead holder. */
  const takeMutex = (): boolean => {
    if (install(mutexPath, mutexToken, false)) return true;
    const judged = identity(mutexPath);
    if (judged && isStale(mutexPath, reclaimGraceMs, true)) {
      removeIfSame(mutexPath, judged);
      return install(mutexPath, mutexToken, false);
    }
    return false;
  };
  const releaseMutex = () => {
    if (readOwner(mutexPath)?.token === mutexToken) fs.rmSync(mutexPath, { recursive: true, force: true });
  };
  /** Reclaims a stale lock under the mutex. Returns whether it removed it. */
  const reclaim = (): boolean => {
    if (!takeMutex()) return false;
    try {
      const judged = identity(lockPath);
      if (!judged || !isStale(lockPath, graceMs, false)) return false;
      opts.hooks?.beforeAct?.('reclaim');
      removeIfSame(lockPath, judged);
      return !fs.existsSync(lockPath);
    } finally { releaseMutex(); }
  };

  /** One attempt: 'taken', 'again' (state changed, retry now) or 'wait' (poll later). */
  const step = (): 'taken' | 'again' | 'wait' => {
    fs.mkdirSync(opts.dir, { recursive: true });
    if (!fs.existsSync(lockPath)) return install(lockPath, token, true) ? 'taken' : 'again';
    if (isStale(lockPath, graceMs, false) && reclaim()) return 'again';
    return 'wait';
  };

  const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const t = setTimeout(done, ms);
    t.unref?.();
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });

  const take = async (signal: AbortSignal): Promise<void> => {
    let again = 0;
    for (;;) {
      if (signal.aborted) throw abortError();
      let next: 'taken' | 'again' | 'wait';
      try { next = step(); } catch (e) {
        if (!isTransient(e)) throw lockError(e);
        next = 'wait';
      }
      if (next === 'taken') {
        held = true;
        if (signal.aborted) { releaseHeld(); throw abortError(); }
        return;
      }
      if (next === 'again' && ++again < 3) continue;
      again = 0;
      opts.hooks?.onWait?.();
      await wait(pollMs, signal);
    }
  };

  const releaseHeld = () => {
    if (!held) return;
    held = false;
    try {
      if (readOwner(lockPath)?.token !== token) return; // reclaimed by someone else: not ours to remove
      opts.hooks?.beforeAct?.('release');
      try { fs.unlinkSync(marker); } catch { return; } // the dir at lockPath is no longer ours
      try { fs.unlinkSync(path.join(lockPath, 'owner.json')); } catch { /* already gone */ }
      try { fs.rmdirSync(lockPath); } catch { /* ENOTEMPTY: a newcomer replaced the emptied dir; it is theirs */ }
    } catch { /* release never throws */ }
  };

  return {
    acquire(a) {
      if (closed) return Promise.reject(abortError());
      const signal = a?.signal ? AbortSignal.any([a.signal, closer.signal]) : closer.signal;
      // In-process FIFO: each acquire waits for the previous one to settle before touching the filesystem.
      const turn = queue.catch(() => {}).then(async () => {
        // A previous acquire from this instance still holds the lock: wait for release().
        while (held) {
          if (signal.aborted) throw abortError();
          await wait(pollMs, signal);
        }
        await take(signal);
      });
      queue = turn;
      return turn;
    },
    async release() { releaseHeld(); },
    close() {
      if (closed) return;
      closed = true;
      closer.abort();
      releaseHeld();
    },
  };
}
