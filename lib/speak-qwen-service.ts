import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';

// T38 (S13): lifecycle of the shared Qwen service, client side. The service itself is scripts/speak-qwen-service.mjs.
export const QWEN_SERVICE_SCHEMA = 'gentle.speak.qwen-service/v1';
/** Bump when the socket protocol changes without a package version change; part of the handshake version. */
export const QWEN_SERVICE_PROTOCOL_REV = 1;
const PACKAGE_VERSION: string = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();
export const qwenServiceVersion = (): string => `${PACKAGE_VERSION}+p${QWEN_SERVICE_PROTOCOL_REV}`;

export interface QwenServicePaths { dir: string; socket: string; pid: string; lock: string; log: string }
export const qwenServicePaths = (home: string): QwenServicePaths => ({ dir: home, socket: join(home, 'qwen.sock'), pid: join(home, 'qwen-service.pid'), lock: join(home, 'qwen-service.lock'), log: join(home, 'qwen-service.log') });

/** The service log is rotated at start once it passes this size, so it never grows without bound. */
export const QWEN_SERVICE_LOG_MAX = 512 * 1024;
const LOCK_STALE_MS = 60_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface QwenServiceOptions {
  /** `<sharedHome>`: holds the socket, pid file, lock and log, and `voices/qwen3`. */
  home: string;
  /** The Qwen interpreter (manifest) and the worker script the service owns. */
  python: string;
  script: string;
  /** scripts/speak-qwen-service.mjs */
  serviceScript: string;
  /** S13: ms of inactivity after which the service closes its Python worker; `null` never. */
  idleMs: number | null;
  /** Environment of the started service (and so of its Python): {@link qwenPythonEnv}. */
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  /** Expected handshake version; defaults to {@link qwenServiceVersion}. */
  version?: string;
  /** Bound for the whole connect-or-start. Default 20 s. */
  timeoutMs?: number;
  /** Tests: the service exits this long after its last client left. */
  exitIdleMs?: number;
  /** Tests: the current user id. */
  uid?: number;
}
export interface QwenServiceConnection { socket: net.Socket; version: string; pid: number; /** Bytes that arrived after the hello line. */ rest: string }

/** Creates the home directory when missing, refuses one the current user does not own, and makes it private (0700). */
export function ensurePrivateHome(home: string, uid: number | undefined = process.getuid?.()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = lstatSync(home);
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new Error('Qwen service directory is not a directory owned by the current user');
  if ((stat.mode & 0o077) !== 0) chmodSync(home, 0o700);
}

type Attempt = { ok: true; connection: QwenServiceConnection } | { ok: false; code: string };
/** One connection attempt: connects and reads the `hello` line. `code` is the socket error (`ECONNREFUSED`, `ENOENT`, ...) or `EPROTO`. */
function attempt(socketPath: string, timeoutMs = 3000): Promise<Attempt> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    socket.setEncoding('utf8');
    let buffer = '', settled = false;
    const settle = (result: Attempt) => { if (settled) return; settled = true; clearTimeout(timer); socket.removeAllListeners('data'); socket.removeAllListeners('error'); if (!result.ok) socket.destroy(); else socket.on('error', () => { /* owner handles close */ }); resolve(result); };
    const timer = setTimeout(() => settle({ ok: false, code: 'ETIMEDOUT' }), timeoutMs);
    socket.on('error', (error: NodeJS.ErrnoException) => settle({ ok: false, code: error.code ?? 'EUNKNOWN' }));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) { if (buffer.length > 4096) settle({ ok: false, code: 'EPROTO' }); return; }
      try {
        const hello = JSON.parse(buffer.slice(0, at));
        if (hello?.schema !== QWEN_SERVICE_SCHEMA || hello.type !== 'hello' || typeof hello.version !== 'string') throw new Error('not a hello');
        settle({ ok: true, connection: { socket, version: hello.version, pid: Number.isSafeInteger(hello.pid) ? hello.pid : 0, rest: buffer.slice(at + 1) } });
      } catch { settle({ ok: false, code: 'EPROTO' }); }
    });
    socket.on('close', () => settle({ ok: false, code: 'ECLOSED' }));
  });
}

const readPid = (path: string): number | undefined => { try { const pid = Number(readFileSync(path, 'utf8').trim()); return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined; } catch { return undefined; } };
/** A live process that is (as far as `ps` can tell) the Qwen service: a recycled pid of an unrelated process does not count. */
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  try { return /qwen-service/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 })); } catch { return false; }
};
const removeQuiet = (path: string) => { try { rmSync(path, { force: true }); } catch { /* best effort */ } };

function acquireLock(path: string): boolean {
  try { mkdirSync(path, { mode: 0o700 }); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try { if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) { rmdirSync(path); return acquireLock(path); } } catch { /* raced: try again later */ }
    return false;
  }
}
const releaseLock = (path: string) => { try { rmdirSync(path); } catch { /* gone */ } };

/** Opens the (size-bounded) log for the detached service's stdout and stderr. */
function openLog(path: string): number {
  try { if (statSync(path).size > QWEN_SERVICE_LOG_MAX) renameSync(path, path + '.1'); } catch { /* missing */ }
  return openSync(path, 'a', 0o600);
}

/** Starts the detached service. Throws when the process cannot be created; never waits for it. */
function startService(options: QwenServiceOptions, paths: QwenServicePaths, version: string): { exited: () => boolean } {
  const fd = openLog(paths.log);
  const argv = [options.serviceScript, '--home', options.home, '--python', options.python, '--script', options.script, '--version', version, '--idle-ms', options.idleMs === null ? 'never' : String(options.idleMs)];
  if (options.exitIdleMs !== undefined) argv.push('--exit-idle-ms', String(options.exitIdleMs));
  let exited = false;
  try {
    const child = spawnChild(options.nodePath ?? process.execPath, argv, { detached: true, stdio: ['ignore', fd, fd], env: options.env ?? process.env });
    child.on('error', () => { exited = true; });
    child.on('exit', () => { exited = true; });
    child.unref();
    if (child.pid) { try { writeFileSync(paths.pid, String(child.pid), { mode: 0o600 }); } catch { /* the service writes it too */ } }
  } finally { closeSync(fd); }
  return { exited: () => exited };
}

/**
 * Connects to the shared service, starting it when nobody runs it.
 * - Start races are settled by an exclusive `mkdir` lock; the loser waits and connects.
 * - A socket whose pid file names a dead process is stale: it is removed, then the service is started.
 * - An outdated service (handshake version differs) is asked to exit once its queue drains, then replaced (once).
 * Rejects when the service cannot be reached within `timeoutMs`; the caller falls back to a local worker.
 */
export async function connectQwenService(options: QwenServiceOptions): Promise<QwenServiceConnection> {
  const version = options.version ?? qwenServiceVersion();
  const paths = qwenServicePaths(options.home);
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  ensurePrivateHome(options.home, options.uid ?? process.getuid?.());
  let replaced = false;
  let ownedLock = false;
  try {
    while (Date.now() < deadline) {
      const result = await attempt(paths.socket, Math.max(200, Math.min(3000, deadline - Date.now())));
      if (result.ok) {
        const { connection } = result;
        if (connection.version === version) return connection;
        if (replaced) { connection.socket.destroy(); throw new Error('Qwen service version mismatch after restart'); }
        replaced = true;
        connection.socket.write(JSON.stringify({ schema: QWEN_SERVICE_SCHEMA, type: 'shutdown' }) + '\n');
        connection.socket.destroy();
        continue; // the old one stops listening at once and exits once its queue drains; the loop below waits for that
      }
      if (!['ECONNREFUSED', 'ENOENT', 'ECLOSED', 'ECONNRESET'].includes(result.code)) throw new Error(`Qwen service unreachable (${result.code})`);
      if (alive(readPid(paths.pid)) ) { await sleep(50); continue; } // starting up elsewhere, or an old service still draining
      if (!ownedLock) {
        if (!acquireLock(paths.lock)) { await sleep(50); continue; }
        ownedLock = true;
        continue; // somebody may have started it while we took the lock: look again before touching anything
      }
      removeQuiet(paths.socket); removeQuiet(paths.pid); // stale leftovers of a dead service, removed only under the lock
      const started = startService(options, paths, version);
      while (Date.now() < deadline) {
        const next = await attempt(paths.socket, Math.max(200, Math.min(1000, deadline - Date.now())));
        if (next.ok) { if (next.connection.version === version) return next.connection; next.connection.socket.destroy(); throw new Error('Qwen service version mismatch after restart'); }
        if (started.exited()) throw new Error('Qwen service exited at start (see qwen-service.log)');
        await sleep(40);
      }
    }
    throw new Error('Qwen service did not answer in time');
  } finally { if (ownedLock) releaseLock(paths.lock); }
}

/** Asks a running service to stop at once (`/speak` → "Detener servicio Qwen"). `true` when one was running. */
export async function stopQwenService(home: string, timeoutMs = 5000): Promise<boolean> {
  const paths = qwenServicePaths(home);
  if (!existsSync(paths.socket)) return false;
  const result = await attempt(paths.socket, timeoutMs);
  if (!result.ok) return false;
  const { socket } = result.connection;
  const closed = new Promise<void>(resolve => { socket.once('close', () => resolve()); setTimeout(resolve, timeoutMs).unref?.(); });
  socket.write(JSON.stringify({ schema: QWEN_SERVICE_SCHEMA, type: 'shutdown', now: true }) + '\n');
  await closed;
  socket.destroy();
  return true;
}
