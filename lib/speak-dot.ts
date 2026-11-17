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
import * as nodeFs from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { realHome } from './speak-home.ts';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_FILE, parseSpeakSettingsFile, serializeSpeakSettings, type SpeakSettings } from './speak-settings.ts';

// Gentle Dot's engine home, its settings.json `packages`, and the connect/disconnect edits. Pure and injectable
// (fs, env, home); nothing here reads or writes anything the caller did not name.

export type DotFs = Pick<typeof nodeFs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'copyFileSync' | 'existsSync' | 'unlinkSync' | 'mkdirSync'> & Partial<Pick<typeof nodeFs, 'readdirSync' | 'chmodSync'>>;
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
/**
 * The git source forms Pi documents (docs/packages.md:13, :38, :39): `git:<host>/<owner>/<repo>[@ref]` and `https://<host>/<owner>/<repo>`; Pi documents no ssh, file or git@ form.
 * Accepted here for the repository `gentle-speak` only, with an optional `.git` and `@ref` (`[A-Za-z0-9._/-]{1,100}`); no credentials, query or fragment.
 */
const GIT_SPEAK_SOURCE = /^(?:git:|https:\/\/)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/gentle-speak(?:\.git)?(?:@[A-Za-z0-9._/-]{1,100})?$/;
export const isGitSpeakSource = (source: string): boolean => GIT_SPEAK_SOURCE.test(source);
/** Whether a `packages` entry (string or `{ source }`) points at gentle-speak: npm, git or a local path whose last segment is `gentle-speak`. */
export const isSpeakEntry = (entry: unknown): boolean => { const source = entrySource(entry)?.trim(); return source !== undefined && (GENTLE_SPEAK_SOURCE.test(source) || isGitSpeakSource(source)); };

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

/** This package's name: the only package.json `name` a local source may hold (checked against the real package.json by the tests). */
export const SPEAK_PACKAGE_NAME = '@e-evolution/gentle-speak';
/** The unscoped name used before the package moved to the `@e-evolution` scope: existing installs and Dot connections keep working. */
export const LEGACY_SPEAK_PACKAGE_NAME = 'gentle-speak';
const SPEAK_PACKAGE_NAMES: readonly unknown[] = [SPEAK_PACKAGE_NAME, LEGACY_SPEAK_PACKAGE_NAME];
const NPM_SPEAK_SPEC = /^npm:(?:@e-evolution\/)?gentle-speak(?:@[A-Za-z0-9._~^<>=*|-]+)?$/;
/** R1: a local source must be absolute, an existing dir whose package.json `name` is this package; anything else must be a well-formed npm spec or a git source (`isGitSpeakSource`) for this package. */
function validSource(source: string, io: DotIo): boolean {
  const fs = io.fs ?? nodeFs;
  if (/^npm:/i.test(source)) return NPM_SPEAK_SPEC.test(source);
  if (/^(?:git:|https:)/i.test(source)) return isGitSpeakSource(source);
  if (!isLocalPath(source) || !isAbsolute(source)) return false;
  try { return SPEAK_PACKAGE_NAMES.includes(JSON.parse(String(fs.readFileSync(join(source, 'package.json'), 'utf8')))?.name); } catch { return false; }
}
/**
 * The entry `connectDot` may write: `terminalSource`, but only when it is exactly a usable source (see `validSource`); undefined otherwise,
 * so the caller refuses with a notice instead of writing an arbitrary, relative or different-package path into Dot's settings.json.
 */
export function resolveDotSource(io: DotIo & { packageRoot: string }): PackageEntry | undefined {
  const entry = terminalSource(io), source = entrySource(entry);
  return source !== undefined && validSource(source, io) ? entry : undefined;
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

/** Dot's HOME: `GENTLE_DOT_HOME`, else `dirname(<Dot agent home>)/home` (gentle-dot's daemon sets `HOME = join(dataDir, "home")`). */
export function dotHome(io: DotIo = {}): string {
  const env = io.env ?? process.env, home = io.home ?? realHome();
  return env.GENTLE_DOT_HOME ? resolve(expandHome(env.GENTLE_DOT_HOME, home)) : join(dirname(dotAgentHome(io)), 'home');
}
/** Dot's own speak settings file: `<dotHome>/.gentle-speak/speak-settings.json`. */
export const dotSpeakFile = (io: DotIo = {}): string => join(dotHome(io), '.gentle-speak', SPEAK_SETTINGS_FILE);

export type DotSpeakRead = { state: 'absent' | 'malformed'; path: string } | { state: 'ok'; path: string; settings: SpeakSettings };
/** Reads Dot's speak settings. `malformed` is any existing file that does not pass the settings schema; it is never overwritten. */
export function readDotSpeak(io: DotIo = {}): DotSpeakRead {
  const fs = io.fs ?? nodeFs, path = dotSpeakFile(io);
  if (!fs.existsSync(path)) return { state: 'absent', path };
  try {
    const settings = parseSpeakSettingsFile(String(fs.readFileSync(path, 'utf8')));
    return settings ? { state: 'ok', path, settings } : { state: 'malformed', path };
  } catch { return { state: 'malformed', path }; }
}
/** What Dot starts with: the terminal's voice, mode, speed, summary model and Mac preferences; `enabled` off, `copySpeech` off, no Dot offer. */
export const seedDotSettings = (terminal: SpeakSettings): SpeakSettings => ({
  ...structuredClone(DEFAULT_SPEAK_SETTINGS), enabled: false, copySpeech: false, voice: terminal.voice, mode: terminal.mode, speed: terminal.speed,
  summaryModel: terminal.summaryModel ? { ...terminal.summaryModel } : null, macVoice: terminal.macVoice, macFallback: terminal.macFallback,
});
/**
 * `mkdir`'s mode only applies to a directory it creates: tighten `<dotHome>/.gentle-speak` to 0700 when it is ours (we just created it, or it
 * holds nothing but our settings file and its temp files). Never another directory (Dot's own home) and never one that holds foreign files.
 */
function secureOwnDir(dir: string, existed: boolean, fs: DotFs) {
  try {
    const ours = !existed || (fs.readdirSync?.(dir) ?? ['?']).every(name => name === SPEAK_SETTINGS_FILE || (name.startsWith(`${SPEAK_SETTINGS_FILE}.`) && name.endsWith('.tmp')));
    if (ours) fs.chmodSync?.(dir, 0o700);
  } catch { /* best effort: the settings file itself is 0600 */ }
}
/** Validates with the settings schema, then temp file plus rename (mode 0600) in a 0700 directory. Throws on invalid settings or I/O failure. */
export function writeDotSpeak(settings: SpeakSettings, io: DotIo = {}): string {
  const fs = io.fs ?? nodeFs, path = dotSpeakFile(io), text = serializeSpeakSettings(settings), temporary = `${path}.${randomUUID()}.tmp`;
  const dir = dirname(path), existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  secureOwnDir(dir, existed, fs);
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path);
  } finally { try { fs.unlinkSync(temporary); } catch { /* the rename consumed it */ } }
  return path;
}
