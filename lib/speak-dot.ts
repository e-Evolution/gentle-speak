import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { realHome } from './speak-home.ts';

// S12: Gentle Dot's engine home, its settings.json `packages`, and the connect/disconnect edits. Pure and injectable
// (fs, env, home); nothing here reads or writes anything the caller did not name.

export type DotFs = Pick<typeof nodeFs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'copyFileSync' | 'existsSync' | 'unlinkSync'>;
export interface DotIo { fs?: DotFs; env?: Record<string, string | undefined>; home?: string }
export type PackageEntry = string | { source: string; [key: string]: unknown };

const BACKUP_INFIX = '.gentle-speak-backup-';
const expandHome = (path: string, home: string) => path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;

/** The agent dir this process runs under: `PI_CODING_AGENT_DIR` (pi-coding-agent `config.getAgentDir`), which gentle-shell also sets as `GENTLE_PI_AGENT_HOME`; else `~/.pi/agent`. */
export function sessionAgentDir(io: DotIo = {}): string {
  const env = io.env ?? process.env, home = io.home ?? realHome();
  return resolve(expandHome(env.PI_CODING_AGENT_DIR || env.GENTLE_PI_AGENT_HOME || join(home, '.pi', 'agent'), home));
}
/** Gentle Dot's engine home: `GENTLE_DOT_AGENT_HOME`, else `<real home>/.gentle-dot/agent` (the real home, not `$HOME`: Dot overrides it). */
export function dotAgentHome(io: DotIo = {}): string {
  const env = io.env ?? process.env, home = io.home ?? realHome();
  return resolve(expandHome(env.GENTLE_DOT_AGENT_HOME || join(home, '.gentle-dot', 'agent'), home));
}
/** True when this process is Gentle Dot's engine: `GENTLE_SPEAK_DOT=1`, or its agent dir is Dot's engine home. */
export function isDotEngine(io: DotIo = {}): boolean {
  const env = io.env ?? process.env;
  return env.GENTLE_SPEAK_DOT === '1' || sessionAgentDir(io) === dotAgentHome(io);
}

const entrySource = (entry: unknown): string | undefined => typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof (entry as any).source === 'string' ? (entry as any).source : undefined;
const GENTLE_SPEAK_SOURCE = /(?:^|[\/\\:])gentle-speak(?:@[^\/\\]*)?(?:\.git)?[\/\\]?$/;
/** Whether a `packages` entry (string or `{ source }`) points at gentle-speak: npm, git or a local path whose last segment is `gentle-speak`. */
export const isSpeakEntry = (entry: unknown): boolean => { const source = entrySource(entry); return source !== undefined && GENTLE_SPEAK_SOURCE.test(source.trim()); };

export type DotSettingsRead = { state: 'absent'; path: string } | { state: 'malformed'; path: string } | { state: 'ok'; path: string; json: Record<string, unknown>; packages: unknown[] };
/** Reads Dot's settings.json. `malformed` covers invalid JSON, a non-object file and a `packages` that is not an array. */
export function readDotSettings(dotHome: string, io: DotIo = {}): DotSettingsRead {
  const fs = io.fs ?? nodeFs;
  const path = join(dotHome, 'settings.json');
  if (!fs.existsSync(path)) return { state: 'absent', path };
  try {
    const json = JSON.parse(String(fs.readFileSync(path, 'utf8')));
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return { state: 'malformed', path };
    if (Object.hasOwn(json, 'packages') && !Array.isArray(json.packages)) return { state: 'malformed', path };
    return { state: 'ok', path, json, packages: json.packages ?? [] };
  } catch { return { state: 'malformed', path }; }
}

export type DotDetection = { state: 'absent' | 'malformed'; path: string } | { state: 'ready'; path: string; connected: boolean };
export function detectDot(io: DotIo = {}): DotDetection {
  const read = readDotSettings(dotAgentHome(io), io);
  return read.state === 'ok' ? { state: 'ready', path: read.path, connected: read.packages.some(isSpeakEntry) } : { state: read.state, path: read.path };
}
export const isConnected = (io: DotIo = {}): boolean => { const found = detectDot(io); return found.state === 'ready' && found.connected; };

const isLocalPath = (source: string) => !/^(?:npm|git|https?|ssh|file|github|gh):/i.test(source) && !/^git@/.test(source);
/**
 * The package source this terminal uses for gentle-speak, rewritten to work from Dot's agent dir: a local path is resolved
 * against the terminal agent dir and written absolute (Dot's HOME differs, so `~` is expanded too); npm/git sources are copied as is.
 * Falls back to `packageRoot` (the installed package itself) when the terminal settings carry no entry.
 */
export function terminalSource(io: DotIo & { packageRoot: string }): PackageEntry {
  const fs = io.fs ?? nodeFs, home = io.home ?? realHome(), dir = sessionAgentDir(io);
  const reroot = (source: string) => isLocalPath(source) ? (isAbsolute(source) || source.startsWith('~') ? resolve(expandHome(source, home)) : resolve(dir, source)) : source;
  try {
    const json = JSON.parse(String(fs.readFileSync(join(dir, 'settings.json'), 'utf8')));
    const entry = Array.isArray(json?.packages) ? (json.packages as unknown[]).find(isSpeakEntry) : undefined;
    if (typeof entry === 'string') return reroot(entry);
    if (entry && typeof entry === 'object') return { ...(entry as object), source: reroot(entrySource(entry) as string) } as PackageEntry;
  } catch { /* no readable terminal settings: use the package itself */ }
  return resolve(io.packageRoot);
}

export type DotChange = { ok: true; changed: boolean; backup?: string } | { ok: false; reason: 'absent' | 'malformed' | 'io' };

/** Copies settings.json next to itself as `settings.json.gentle-speak-backup-<timestamp>`; never overwrites an earlier backup. */
export function backupDotSettings(path: string, io: DotIo & { now?: () => Date } = {}): string {
  const fs = io.fs ?? nodeFs;
  const stamp = (io.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  for (let n = 0; ; n++) {
    const target = `${path}${BACKUP_INFIX}${stamp}${n ? `-${n}` : ''}`;
    if (!fs.existsSync(target)) { fs.copyFileSync(path, target, nodeFs.constants.COPYFILE_EXCL); return target; }
  }
}

/** Temp file plus rename, mode 0600, 2-space JSON: every other key keeps its value and order. */
function writeAtomic(path: string, json: unknown, fs: DotFs) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(json, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path);
  } finally { try { fs.unlinkSync(temporary); } catch { /* the rename consumed it */ } }
}

function change(dotHome: string, io: DotIo & { now?: () => Date }, edit: (packages: unknown[]) => unknown[] | undefined): DotChange {
  const fs = io.fs ?? nodeFs;
  const read = readDotSettings(dotHome, io);
  if (read.state !== 'ok') return { ok: false, reason: read.state };
  const next = edit(read.packages);
  if (!next) return { ok: true, changed: false };
  try {
    const backup = backupDotSettings(read.path, io);
    writeAtomic(read.path, { ...read.json, packages: next }, fs);
    return { ok: true, changed: true, backup };
  } catch { return { ok: false, reason: 'io' }; }
}
/** Adds `source` to Dot's `packages` after a backup; a no-op (no backup, no write) when gentle-speak is already there. A malformed file is never written. */
export const connectDot = (source: PackageEntry, io: DotIo & { now?: () => Date } = {}): DotChange =>
  change(dotAgentHome(io), io, packages => packages.some(isSpeakEntry) ? undefined : [...packages, source]);
/** Removes only gentle-speak entries from Dot's `packages` after a backup; a no-op when it is not there. */
export const disconnectDot = (io: DotIo & { now?: () => Date } = {}): DotChange =>
  change(dotAgentHome(io), io, packages => packages.some(isSpeakEntry) ? packages.filter(entry => !isSpeakEntry(entry)) : undefined);
