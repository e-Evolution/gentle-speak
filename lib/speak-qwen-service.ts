import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { execFile, spawn as spawnChild } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';

// T38 (S13): lifecycle of the shared Qwen service, client side. The service itself is scripts/speak-qwen-service.mjs.
export const QWEN_SERVICE_SCHEMA = 'gentle.speak.qwen-service/v1';
/** Bump when the socket protocol changes without a package version change; part of the handshake version. */
export const QWEN_SERVICE_PROTOCOL_REV = 1;
const PACKAGE_VERSION: string = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();
export const qwenServiceVersion = (): string => `${PACKAGE_VERSION}+p${QWEN_SERVICE_PROTOCOL_REV}`;
/**
 * T50 (L98): the build id, the first 12 hex chars of a sha256 over the exact bytes of the service script then the worker script (each preceded by its byte length, so the
 * split point is part of the hash). The package version alone never changed between builds, so an old service kept running; the build id changes with any code change.
 * scripts/speak-qwen-service.mjs derives it the same way for its own script and worker (a test pins them equal). `undefined` when a script cannot be read.
 */
export function qwenBuildId(serviceScript: string, workerScript: string): string | undefined {
  try {
    const hash = createHash('sha256');
    for (const file of [serviceScript, workerScript]) { const bytes = readFileSync(file); hash.update(`${bytes.length}:`); hash.update(bytes); }
    return hash.digest('hex').slice(0, 12);
  } catch { return undefined; }
}

export interface QwenServicePaths { dir: string; socket: string; pid: string; lock: string; log: string; restart: string }
export const qwenServicePaths = (home: string): QwenServicePaths => ({ dir: home, socket: join(home, 'qwen.sock'), pid: join(home, 'qwen-service.pid'), lock: join(home, 'qwen-service.lock'), log: join(home, 'qwen-service.log'), restart: join(home, 'qwen-service.restart') });

/** Semver 2.0 precedence of two prerelease strings (`''` = a release, which outranks any prerelease): numeric identifiers numerically, others lexically, numeric before alphanumeric, fewer fields first. */
function comparePrerelease(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  const left = a.split('.'), right = b.split('.');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!, y = right[i]!;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return left.length === right.length ? 0 : left.length > right.length ? 1 : -1;
}

/**
 * Orders two handshake versions (`<major>.<minor>.<patch>[-<prerelease>]+p<rev>`): 1 when `a` is newer than `b`, -1 when older, 0 when equal, `undefined` when either
 * does not parse (then nothing can be said about who is newer). The package version decides first (semver precedence: `1.0.0-beta` is older than `1.0.0`), then the protocol revision.
 */
export function compareQwenServiceVersions(a: string, b: string): number | undefined {
  const parse = (v: string) => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\+p(\d+)$/.exec(v); return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '', rev: Number(m[5]) } : undefined; };
  const left = parse(a), right = parse(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! > right.core[i]! ? 1 : -1;
  const pre = comparePrerelease(left.pre, right.pre);
  if (pre !== 0) return pre;
  return left.rev === right.rev ? 0 : left.rev > right.rev ? 1 : -1;
}
const protocolRev = (version: string): string | undefined => /\+p(\d+)$/.exec(version)?.[1];

/** The service log is rotated at start once it passes this size, so it never grows without bound. */
export const QWEN_SERVICE_LOG_MAX = 512 * 1024;
const LOCK_STALE_MS = 60_000;
/** A service is replaced at most once per this window (a second, different replacement inside it is refused), so clients never take turns restarting it. */
export const QWEN_SERVICE_RESTART_WINDOW_MS = 30_000;
const PS_TIMEOUT_MS = 1500;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface QwenServiceOptions {
  /** `<sharedHome>`: holds the socket, pid file, lock and log, and `voices/qwen3`. */
  home: string;
  /** The Qwen interpreter (manifest) and the worker script the service owns. */
  python: string;
  script: string;
  /** scripts/speak-qwen-service.mjs */
  serviceScript: string;
  /** S13 (L83): the grace in ms after the LAST client disconnects, after which the service unloads Python and exits; `null` never. Read at service start. */
  idleMs: number | null;
  /** Environment of the started service (and so of its Python): {@link qwenPythonEnv}. */
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  /** Expected handshake version; defaults to {@link qwenServiceVersion}. */
  version?: string;
  /** Bound for the whole connect-or-start. Default 20 s. */
  timeoutMs?: number;
  /** Tests: overrides the grace (the service exits this long after its last client left). */
  exitIdleMs?: number;
  /** Tests: the `ps` executable and its bound (ms). */
  psPath?: string;
  psTimeoutMs?: number;
  /** Tests: the minimum time between two service replacements. */
  restartWindowMs?: number;
  /** Tests: the current user id. */
  uid?: number;
}
export interface QwenServiceConnection { socket: net.Socket; version: string; /** The service's build id; absent for a service older than T50. */ build?: string; pid: number; /** Bytes that arrived after the hello line. */ rest: string }

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
        settle({ ok: true, connection: { socket, version: hello.version, ...(typeof hello.build === 'string' ? { build: hello.build } : {}), pid: Number.isSafeInteger(hello.pid) ? hello.pid : 0, rest: buffer.slice(at + 1) } });
      } catch { settle({ ok: false, code: 'EPROTO' }); }
    });
    socket.on('close', () => settle({ ok: false, code: 'ECLOSED' }));
  });
}

const readPid = (path: string): number | undefined => { try { const pid = Number(readFileSync(path, 'utf8').trim()); return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined; } catch { return undefined; } };
/** A live process that is (as far as `ps` can tell) the Qwen service: a recycled pid of an unrelated process does not count. */
const alive = async (pid: number | undefined, ps = 'ps', timeoutMs = PS_TIMEOUT_MS): Promise<boolean> => {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  // Asynchronous and bounded: the session's event loop keeps running during the probe, and a hung `ps` is killed and counted as "not ours".
  return new Promise<boolean>(resolve => { try { execFile(ps, ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => resolve(!error && /qwen-service/.test(stdout))); } catch { resolve(false); } });
};
const readRestart = (path: string): { at: number; version: string } | undefined => { try { const stamp = JSON.parse(readFileSync(path, 'utf8')); return typeof stamp?.at === 'number' && typeof stamp.version === 'string' ? stamp : undefined; } catch { return undefined; } };
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
 * - An outdated service (handshake version or build id differs) is asked to exit once its queue drains, then replaced (once).
 * Rejects when the service cannot be reached within `timeoutMs`; the caller falls back to a local worker.
 */
export async function connectQwenService(options: QwenServiceOptions): Promise<QwenServiceConnection> {
  const version = options.version ?? qwenServiceVersion();
  const paths = qwenServicePaths(options.home);
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  ensurePrivateHome(options.home, options.uid ?? process.getuid?.());
  // T50: the same package version and protocol with another build (or none: a pre-T50 service) is a different service. Unknown own build (unreadable scripts): no build check.
  const build = qwenBuildId(options.serviceScript, options.script);
  const identity = `${version}#${build ?? ''}`;
  const current = (connection: QwenServiceConnection) => connection.version === version && (build === undefined || connection.build === build);
  let replaced = false;
  let ownedLock = false;
  try {
    while (Date.now() < deadline) {
      const result = await attempt(paths.socket, Math.max(200, Math.min(3000, deadline - Date.now())));
      if (result.ok) {
        const { connection } = result;
        if (current(connection)) return connection;
        if (replaced) { connection.socket.destroy(); throw new Error('Qwen service version mismatch after restart'); }
        // Who is newer decides (a service of a newer version is never replaced by an older client), and replacements are rate-limited.
        const order = compareQwenServiceVersions(version, connection.version);
        const compatible = protocolRev(version) !== undefined && protocolRev(version) === protocolRev(connection.version);
        const refuse = (why: string) => { if (compatible && order !== undefined) return connection; connection.socket.destroy(); throw new Error(`Qwen service is ${why}; using a local worker instead`); };
        if (order !== undefined && order < 0) return refuse('newer and not compatible with this client') ;
        const stamp = readRestart(paths.restart);
        if (stamp && Date.now() - stamp.at < (options.restartWindowMs ?? QWEN_SERVICE_RESTART_WINDOW_MS)) {
          if (stamp.version === identity) { connection.socket.destroy(); await sleep(50); continue; } // someone already replaced it for our version: wait for that
          return refuse('restarted recently by a client of another version');
        }
        replaced = true;
        try { writeFileSync(paths.restart, JSON.stringify({ at: Date.now(), version: identity }), { mode: 0o600 }); } catch { /* the rate limit is best effort */ }
        connection.socket.write(JSON.stringify({ schema: QWEN_SERVICE_SCHEMA, type: 'shutdown' }) + '\n');
        connection.socket.destroy();
        continue; // the old one stops listening at once and exits once its queue drains; the loop below waits for that
      }
      if (!['ECONNREFUSED', 'ENOENT', 'ECLOSED', 'ECONNRESET'].includes(result.code)) throw new Error(`Qwen service unreachable (${result.code})`);
      if (await alive(readPid(paths.pid), options.psPath, options.psTimeoutMs)) { await sleep(50); continue; } // starting up elsewhere, or an old service still draining
      if (!ownedLock) {
        if (!acquireLock(paths.lock)) { await sleep(50); continue; }
        ownedLock = true;
        continue; // somebody may have started it while we took the lock: look again before touching anything
      }
      removeQuiet(paths.socket); removeQuiet(paths.pid); // stale leftovers of a dead service, removed only under the lock
      const started = startService(options, paths, version);
      while (Date.now() < deadline) {
        const next = await attempt(paths.socket, Math.max(200, Math.min(1000, deadline - Date.now())));
        if (next.ok) { if (current(next.connection)) return next.connection; next.connection.socket.destroy(); throw new Error('Qwen service version mismatch after restart'); }
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
