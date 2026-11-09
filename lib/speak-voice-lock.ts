import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * S9 single voice: a cross-process lock built on atomic `mkdir`. `<dir>/voice.lock/owner.json` holds
 * `{ pid, at, token }`. A lock is stale when its owner pid is dead, or when the owner file is missing or
 * unreadable (a crash between mkdir and write) and the lock directory is older than `graceMs`.
 * Release and stale reclaim both rename the lock aside FIRST and re-verify what they moved (token, or staleness),
 * so a lock retaken between check and act is put back instead of deleted.
 */
export interface VoiceLockOptions {
  dir: string;
  pollMs?: number;
  graceMs?: number;
  now?: () => number;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  /** Test seam: called right before the destructive step, i.e. between the check and the act. */
  hooks?: { beforeAct?: (kind: 'release' | 'reclaim') => void };
}

export interface AcquireOptions { signal?: AbortSignal }

export interface VoiceLock {
  acquire(opts?: AcquireOptions): Promise<void>;
  release(): Promise<void>;
}

export const defaultIsPidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code !== 'ESRCH'; }
};

const abortError = () => Object.assign(new Error('voice lock acquire aborted'), { name: 'AbortError' });

export function createVoiceLock(opts: VoiceLockOptions): VoiceLock {
  const pollMs = opts.pollMs ?? 100;
  const graceMs = opts.graceMs ?? 5000;
  const now = opts.now ?? Date.now;
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const lockPath = path.join(opts.dir, 'voice.lock');
  const ownerPath = path.join(lockPath, 'owner.json');
  const token = randomUUID();
  let held = false;
  let queue: Promise<unknown> = Promise.resolve();

  const readOwnerAt = (dir: string): { pid: number; token?: string } | undefined => {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
      return o && Number.isInteger(o.pid) ? o : undefined;
    } catch { return undefined; }
  };
  const isStaleAt = (dir: string): boolean => {
    const owner = readOwnerAt(dir);
    if (owner) return !isAlive(owner.pid);
    try { return now() - fs.statSync(dir).mtimeMs > graceMs; } catch { return false; }
  };
  /** Move the lock aside atomically. Undefined when it is gone (somebody else won the race). */
  const moveAside = (): string | undefined => {
    const trash = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try { fs.renameSync(lockPath, trash); return trash; } catch { return undefined; }
  };
  /** What was moved was not ours to remove: put it back; never delete it. */
  const putBack = (trash: string) => { try { fs.renameSync(trash, lockPath); } catch { /* retaken meanwhile: leave it, do not delete a live owner's data */ } };
  const reclaim = () => {
    opts.hooks?.beforeAct?.('reclaim');
    const trash = moveAside();
    if (!trash) return;
    if (isStaleAt(trash)) fs.rmSync(trash, { recursive: true, force: true });
    else putBack(trash);
  };
  const tryTake = (): boolean => {
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      fs.mkdirSync(lockPath);
    } catch (e: any) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    }
    try {
      fs.writeFileSync(ownerPath, JSON.stringify({ pid, at: now(), token }));
    } catch (e) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      throw e;
    }
    return true;
  };
  const wait = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
    const t = setTimeout(done, ms);
    t.unref?.();
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });

  const take = async (signal?: AbortSignal): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw abortError();
      if (tryTake()) { held = true; return; }
      if (isStaleAt(lockPath)) { reclaim(); continue; }
      await wait(pollMs, signal);
    }
  };

  return {
    acquire(a) {
      const signal = a?.signal;
      // In-process FIFO: each acquire waits for the previous one to settle before touching the filesystem.
      const turn = queue.catch(() => {}).then(async () => {
        // A previous acquire from this instance still holds the lock: wait for release().
        while (held) {
          if (signal?.aborted) throw abortError();
          await wait(pollMs, signal);
        }
        await take(signal);
      });
      queue = turn;
      return turn;
    },
    async release() {
      if (!held) return;
      held = false;
      opts.hooks?.beforeAct?.('release');
      const trash = moveAside();
      if (!trash) return;
      if (readOwnerAt(trash)?.token === token) fs.rmSync(trash, { recursive: true, force: true });
      else putBack(trash);
    },
  };
}
