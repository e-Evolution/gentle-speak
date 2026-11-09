/**
 * Copied-selection watcher (S8, decisions L29 → L31). Pure and injectable; no settings, no extension wiring.
 *
 * API
 * - `resolveTerminalBundleId({ env, pid, ppidOf?, commOf?, bundleIdOfAppPath? })` → bundle id | undefined.
 *   Order: `env.__CFBundleIdentifier`; then the ancestor walk from `pid` (ppid/process-path lookups) to the
 *   first `.app/Contents/MacOS/` path, whose `CFBundleIdentifier` is read; then `env.TERM_PROGRAM` mapped to
 *   a bundle id. Defaults use `ps` and `plutil` through `execFile` with timeouts.
 * - `createCopiedSelectionWatcher({ terminalBundleId, spawn, readText, speak, onError })` → `{ start, stop }`.
 *   `start` refuses (calls `onError`, spawns nothing) when `terminalBundleId` is undefined: fail closed.
 *   It spawns ONE persistent `osascript -l JavaScript` loop polling the pasteboard about every 300 ms. On each
 *   `changeCount` change the child prints one line: `GSCLIP<TAB>count<TAB>type,type,...<TAB>frontmostBundleId`.
 *   Lines are parsed strictly; malformed lines are ignored. A copy is spoken only when the frontmost bundle id
 *   equals the terminal's and no type is concealed/transient (`SKIPPED_PASTEBOARD_TYPES`, checked before the
 *   text is ever read). Text is trimmed, empty is skipped and the rest is capped at 4000 chars.
 *   `stop` kills the child and is idempotent. A child crash calls `onError` once; there is no respawn.
 *
 * Privacy: clipboard text is never persisted or logged, and errors never carry it.
 * Known limit: copies in other tabs or windows of the same terminal app are spoken too.
 */
import { execFile, spawn as nodeSpawn } from 'node:child_process';

export const MAX_COPIED_CHARS = 4000;
export const POLL_INTERVAL_MS = 300;
export const LINE_PREFIX = 'GSCLIP';

export const SKIPPED_PASTEBOARD_TYPES: readonly string[] = [
  'org.nspasteboard.ConcealedType',
  'org.nspasteboard.TransientType',
  'com.agilebits.onepassword',
  'de.petermaurer.TransientPasteboardType',
  'com.typeit4me.clipping',
  'com.apple.is-remote-clipboard',
];

export const TERM_PROGRAM_BUNDLE_IDS: Readonly<Record<string, string>> = {
  Apple_Terminal: 'com.apple.Terminal',
  'iTerm.app': 'com.googlecode.iterm2',
  ghostty: 'com.mitchellh.ghostty',
  WezTerm: 'com.github.wez.wezterm',
  vscode: 'com.microsoft.VSCode',
  WarpTerminal: 'dev.warp.Warp-Stable',
};

const MAX_ANCESTORS = 32;
const EXEC_TIMEOUT_MS = 3000;

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined));
  });
}

export const defaultPpidOf = async (pid: number): Promise<number | undefined> => {
  const n = Number(await run('ps', ['-o', 'ppid=', '-p', String(pid)]));
  return Number.isInteger(n) && n > 0 ? n : undefined;
};
export const defaultCommOf = (pid: number): Promise<string | undefined> => run('ps', ['-o', 'comm=', '-p', String(pid)]);
export const defaultBundleIdOfAppPath = (appPath: string): Promise<string | undefined> =>
  run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', `${appPath}/Contents/Info.plist`]);

export interface ResolveTerminalOptions {
  env: Record<string, string | undefined>;
  pid: number;
  ppidOf?: (pid: number) => Promise<number | undefined>;
  commOf?: (pid: number) => Promise<string | undefined>;
  bundleIdOfAppPath?: (appPath: string) => Promise<string | undefined>;
}

const APP_MARKER = '.app/Contents/MacOS/';

export async function resolveTerminalBundleId(opts: ResolveTerminalOptions): Promise<string | undefined> {
  const { env } = opts;
  if (env.__CFBundleIdentifier) return env.__CFBundleIdentifier;
  const ppidOf = opts.ppidOf ?? defaultPpidOf;
  const commOf = opts.commOf ?? defaultCommOf;
  const bundleIdOf = opts.bundleIdOfAppPath ?? defaultBundleIdOfAppPath;
  const seen = new Set<number>();
  let pid: number | undefined = opts.pid;
  for (let i = 0; i < MAX_ANCESTORS && pid !== undefined && pid > 0 && !seen.has(pid); i += 1) {
    seen.add(pid);
    const comm = await commOf(pid);
    const at = comm?.indexOf(APP_MARKER) ?? -1;
    if (comm && at >= 0) {
      const id = await bundleIdOf(comm.slice(0, at + '.app'.length));
      if (id) return id;
    }
    pid = await ppidOf(pid);
  }
  const mapped = env.TERM_PROGRAM ? TERM_PROGRAM_BUNDLE_IDS[env.TERM_PROGRAM] : undefined;
  return mapped;
}

export interface ClipboardLine { count: number; types: string[]; frontmost: string }

/** Strict parse of `GSCLIP\t<count>\t<type,type>\t<bundleId>`; anything else is undefined. */
export function parseClipboardLine(line: string): ClipboardLine | undefined {
  const parts = line.split('\t');
  if (parts.length !== 4 || parts[0] !== LINE_PREFIX) return undefined;
  if (!/^\d+$/.test(parts[1])) return undefined;
  if (!parts[3]) return undefined;
  return { count: Number(parts[1]), types: parts[2] ? parts[2].split(',') : [], frontmost: parts[3] };
}

/**
 * JXA `emit(line)`: writes one line to stdout through NSFileHandle (unbuffered).
 * JXA `console.log` writes to stderr, which the watcher does not read (L51).
 */
export const JXA_EMIT = `function emit(s){$.NSFileHandle.fileHandleWithStandardOutput.writeData($(s+'\\n').dataUsingEncoding($.NSUTF8StringEncoding));}`;

/** JXA loop: silent baseline, then one line per changeCount change. */
export const WATCH_SCRIPT = `${JXA_EMIT}ObjC.import('AppKit');ObjC.import('Foundation');
var pb=$.NSPasteboard.generalPasteboard;var last=pb.changeCount;
while(true){$.NSThread.sleepForTimeInterval(${POLL_INTERVAL_MS / 1000});
var c=pb.changeCount;if(c===last)continue;last=c;
var types=ObjC.deepUnwrap(pb.types)||[];
var app=$.NSWorkspace.sharedWorkspace.frontmostApplication;
var front=app?ObjC.unwrap(app.bundleIdentifier):'';
emit('${LINE_PREFIX}\\t'+c+'\\t'+types.join(',')+'\\t'+front);}`;

export interface WatcherChild {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'error' | 'exit', cb: (...args: any[]) => void): unknown;
  kill(): unknown;
}
export type WatcherSpawn = (command: string, args: string[]) => WatcherChild;

export const defaultSpawn: WatcherSpawn = (command, args) =>
  nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] }) as unknown as WatcherChild;

export interface CopiedSelectionWatcherOptions {
  terminalBundleId: string | undefined;
  spawn?: WatcherSpawn;
  readText?: () => Promise<string>;
  speak: (text: string) => unknown;
  /** Consulted after the frontmost/type checks and before `speak`; absent means every checked copy passes. */
  isOwnCopy?: (text: string) => boolean;
  onError: (error: Error) => void;
}

export const defaultReadText = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('pbpaste', [], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) =>
      err ? reject(new Error('pbpaste failed')) : resolve(String(stdout)));
  });

export function createCopiedSelectionWatcher(opts: CopiedSelectionWatcherOptions): { start(): void; stop(): void } {
  const spawn = opts.spawn ?? defaultSpawn;
  const readText = opts.readText ?? defaultReadText;
  let child: WatcherChild | undefined;
  let started = false;
  let stopped = false;
  let failed = false;

  const fail = (message: string) => {
    if (failed || stopped) return;
    failed = true;
    opts.onError(new Error(message));
  };

  const handle = async (line: ClipboardLine) => {
    if (line.frontmost !== opts.terminalBundleId) return;
    if (line.types.some((t) => SKIPPED_PASTEBOARD_TYPES.includes(t))) return;
    const text = (await readText()).trim().slice(0, MAX_COPIED_CHARS);
    if (!text) return;
    if (opts.isOwnCopy && !opts.isOwnCopy(text)) return;
    // The gate needs the copied lines; speech takes one line, since the speak path rejects control characters (L51).
    await opts.speak(text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim());
  };

  return {
    start() {
      if (started || stopped) return;
      if (!opts.terminalBundleId) {
        started = true;
        fail('gentle-speak: cannot identify the terminal app; copied-text watcher not started');
        return;
      }
      started = true;
      let buffer = '';
      try {
        child = spawn('osascript', ['-l', 'JavaScript', '-e', WATCH_SCRIPT]);
      } catch {
        fail('gentle-speak: copied-text watcher failed to start');
        return;
      }
      child.stdout?.on('data', (chunk) => {
        if (stopped) return;
        buffer += chunk.toString();
        if (buffer.length > 65536) buffer = '';
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const parsed = parseClipboardLine(buffer.slice(0, nl).replace(/\r$/, ''));
          buffer = buffer.slice(nl + 1);
          if (parsed) handle(parsed).catch(() => fail('gentle-speak: copied-text handling failed'));
        }
      });
      child.on('error', () => fail('gentle-speak: copied-text watcher crashed'));
      child.on('exit', () => fail('gentle-speak: copied-text watcher exited'));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { child?.kill(); } catch { /* already gone */ }
    },
  };
}

/** The members of pi-tui's fullscreen `TuiAltScreen` that the own-copy gate reads. */
export interface SelectionTui {
  getCopyOnSelect(): boolean;
  hasActiveSelection(): boolean;
  getScreenLines(): string[];
}

/** True only for the fullscreen TUI, which publicly exposes all three members as functions. */
export function isSelectionTui(tui: unknown): tui is SelectionTui {
  const t = tui as Record<string, unknown> | null | undefined;
  return !!t && ['getCopyOnSelect', 'hasActiveSelection', 'getScreenLines'].every((name) => typeof t[name] === 'function');
}

// CSI sequences and OSC sequences (BEL or ST terminated).
const ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Gentle-Shell-own-copy gate (L33): the copy is ours only while the fullscreen TUI has copy-on-select on,
 * an active selection, and the copied text is visible on screen. Fails closed on any error or missing member.
 */
export function createOwnCopyGate(getTui: () => unknown): (text: string) => boolean {
  return (text) => {
    try {
      const tui = getTui();
      if (!isSelectionTui(tui) || tui.getCopyOnSelect() !== true || tui.hasActiveSelection() !== true) return false;
      const wanted = normalize(text);
      if (!wanted) return false;
      // pi-tui builds the copied text with this (TS-private) method; when present, require the copy to be exactly it (L51).
      const selectionText = (tui as { getActiveSelectionText?: unknown }).getActiveSelectionText;
      if (typeof selectionText === 'function') {
        const selected = selectionText.call(tui);
        if (typeof selected !== 'string') return false;
        const own = normalize(selected);
        return own === wanted || (text.length >= MAX_COPIED_CHARS && own.startsWith(wanted));
      }
      // Fallback: the copied text on screen, either whole or line by line (a multi-row copy skips the right rail).
      const rows = tui.getScreenLines().map((line) => normalize(String(line).replace(ANSI, '')));
      if (normalize(rows.join(' ')).includes(wanted)) return true;
      const lines = text.split('\n').map(normalize).filter(Boolean);
      return lines.every((line) => rows.some((row) => row.includes(line)));
    } catch {
      return false;
    }
  };
}
