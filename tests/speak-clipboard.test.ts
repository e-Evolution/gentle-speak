import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  JXA_EMIT,
  MAX_COPIED_CHARS,
  WATCH_SCRIPT,
  SKIPPED_PASTEBOARD_TYPES,
  createCopiedSelectionWatcher,
  createOwnCopyGate,
  parseClipboardLine,
  resolveTerminalBundleId,
} from '../lib/speak-clipboard.ts';

const TERM = 'com.github.wez.wezterm';

function lookups(chain: Record<number, [number, string]>, bundles: Record<string, string> = {}) {
  const calls: string[] = [];
  return {
    calls,
    ppidOf: async (pid: number) => { calls.push(`ppid:${pid}`); return chain[pid]?.[0]; },
    commOf: async (pid: number) => { calls.push(`comm:${pid}`); return chain[pid]?.[1]; },
    bundleIdOfAppPath: async (p: string) => { calls.push(`bundle:${p}`); return bundles[p]; },
  };
}

test('resolve: __CFBundleIdentifier wins and nothing else is consulted', async () => {
  const l = lookups({});
  const id = await resolveTerminalBundleId({ env: { __CFBundleIdentifier: 'com.a.b', TERM_PROGRAM: 'ghostty' }, pid: 10, ...l });
  assert.equal(id, 'com.a.b');
  assert.deepEqual(l.calls, []);
});

test('resolve: walks ancestors to the first .app/Contents/MacOS path and reads its bundle id', async () => {
  const l = lookups(
    { 30: [20, '/bin/zsh'], 20: [10, '/usr/bin/login'], 10: [1, '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui'] },
    { '/Applications/WezTerm.app': TERM },
  );
  const id = await resolveTerminalBundleId({ env: { TERM_PROGRAM: 'ghostty' }, pid: 30, ...l });
  assert.equal(id, TERM);
  assert.ok(l.calls.includes('bundle:/Applications/WezTerm.app'));
});

test('resolve: ancestor walk gives up at pid 1 / loops and falls back to TERM_PROGRAM', async () => {
  const l = lookups({ 30: [20, '/bin/zsh'], 20: [1, '/bin/login'], 1: [0, '/sbin/launchd'] });
  assert.equal(await resolveTerminalBundleId({ env: { TERM_PROGRAM: 'iTerm.app' }, pid: 30, ...l }), 'com.googlecode.iterm2');
  const loop = lookups({ 5: [5, '/bin/zsh'] });
  assert.equal(await resolveTerminalBundleId({ env: {}, pid: 5, ...loop }), undefined);
});

test('resolve: TERM_PROGRAM mapping', async () => {
  const l = lookups({});
  const map: Record<string, string> = {
    Apple_Terminal: 'com.apple.Terminal', 'iTerm.app': 'com.googlecode.iterm2', ghostty: 'com.mitchellh.ghostty',
    WezTerm: 'com.github.wez.wezterm', vscode: 'com.microsoft.VSCode', WarpTerminal: 'dev.warp.Warp-Stable',
  };
  for (const [tp, bid] of Object.entries(map)) assert.equal(await resolveTerminalBundleId({ env: { TERM_PROGRAM: tp }, pid: 2, ...l }), bid);
});

test('resolve: unresolvable returns undefined (unknown TERM_PROGRAM too)', async () => {
  assert.equal(await resolveTerminalBundleId({ env: { TERM_PROGRAM: 'herdr' }, pid: 2, ...lookups({}) }), undefined);
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  kills = 0;
  kill() { this.kills += 1; return true; }
  line(count: number, types: string[], front: string) { this.stdout.emit('data', Buffer.from(`GSCLIP\t${count}\t${types.join(',')}\t${front}\n`)); }
}

function setup(over: { text?: string; terminalBundleId?: string | undefined } = {}) {
  const child = new FakeChild();
  const spawned: string[][] = [];
  const spoken: string[] = [];
  const errors: Error[] = [];
  let reads = 0;
  const w = createCopiedSelectionWatcher({
    terminalBundleId: 'terminalBundleId' in over ? over.terminalBundleId : TERM,
    spawn: (cmd: string, args: string[]) => { spawned.push([cmd, ...args]); return child as never; },
    readText: async () => { reads += 1; return over.text ?? 'hello'; },
    speak: (t: string) => { spoken.push(t); },
    onError: (e: Error) => { errors.push(e); },
  });
  const flush = () => new Promise((r) => setImmediate(r));
  return { child, spawned, spoken, errors, w, flush, reads: () => reads };
}

test('start refuses without a terminal id: onError, no spawn', () => {
  const s = setup({ terminalBundleId: undefined });
  s.w.start();
  assert.equal(s.spawned.length, 0);
  assert.equal(s.errors.length, 1);
});

test('start spawns exactly one child, even when called twice', () => {
  const s = setup();
  s.w.start(); s.w.start();
  assert.equal(s.spawned.length, 1);
  assert.equal(s.spawned[0][0], 'osascript');
  assert.ok(s.spawned[0].includes('JavaScript'));
});

test('frontmost == terminal speaks the trimmed text', async () => {
  const s = setup({ text: '  hola mundo \n' });
  s.w.start();
  s.child.line(7, ['public.utf8-plain-text'], TERM);
  await s.flush();
  assert.deepEqual(s.spoken, ['hola mundo']);
});

test('frontmost != terminal: no speak and readText not called', async () => {
  const s = setup();
  s.w.start();
  s.child.line(7, ['public.utf8-plain-text'], 'com.apple.Safari');
  await s.flush();
  assert.equal(s.spoken.length, 0);
  assert.equal(s.reads(), 0);
});

for (const type of SKIPPED_PASTEBOARD_TYPES) {
  test(`skipped type ${type}: readText never called`, async () => {
    const s = setup();
    s.w.start();
    s.child.line(3, ['public.utf8-plain-text', type], TERM);
    await s.flush();
    assert.equal(s.reads(), 0);
    assert.equal(s.spoken.length, 0);
    assert.equal(s.errors.length, 0);
  });
}

test('the skipped types are exactly the specified six', () => {
  assert.deepEqual([...SKIPPED_PASTEBOARD_TYPES].sort(), [
    'com.agilebits.onepassword', 'com.apple.is-remote-clipboard', 'com.typeit4me.clipping',
    'de.petermaurer.TransientPasteboardType', 'org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType',
  ]);
});

test('empty or whitespace text is skipped', async () => {
  const s = setup({ text: '  \n\t ' });
  s.w.start();
  s.child.line(1, ['public.utf8-plain-text'], TERM);
  await s.flush();
  assert.equal(s.spoken.length, 0);
});

test('text over 4000 chars is truncated to exactly 4000', async () => {
  const s = setup({ text: 'a'.repeat(9000) });
  s.w.start();
  s.child.line(1, ['public.utf8-plain-text'], TERM);
  await s.flush();
  assert.equal(MAX_COPIED_CHARS, 4000);
  assert.equal(s.spoken[0].length, 4000);
});

test('stop kills the child and is idempotent; later lines are ignored', async () => {
  const s = setup();
  s.w.start();
  s.w.stop(); s.w.stop();
  assert.equal(s.child.kills, 1);
  s.child.line(1, ['public.utf8-plain-text'], TERM);
  await s.flush();
  assert.equal(s.spoken.length, 0);
  assert.equal(s.errors.length, 0);
});

test('a crash calls onError once, with no respawn and no clipboard text', async () => {
  const s = setup();
  s.w.start();
  s.child.emit('exit', 1, null);
  s.child.emit('error', new Error('boom'));
  await s.flush();
  assert.equal(s.errors.length, 1);
  assert.equal(s.spawned.length, 1);
});

test('stop followed by the child exiting is not a crash', () => {
  const s = setup();
  s.w.start(); s.w.stop();
  s.child.emit('exit', null, 'SIGTERM');
  assert.equal(s.errors.length, 0);
});

test('malformed lines are ignored without speaking', async () => {
  const s = setup();
  s.w.start();
  for (const bad of ['garbage\n', 'GSCLIP\tx\ta\t' + TERM + '\n', 'GSCLIP\t1\ta\n', 'GSCLIP\t1\ta\t' + TERM + '\textra\n', '\n']) {
    s.child.stdout.emit('data', Buffer.from(bad));
  }
  await s.flush();
  assert.equal(s.reads(), 0);
  assert.equal(s.spoken.length, 0);
  assert.equal(s.errors.length, 0);
});

test('lines split across chunks are reassembled', async () => {
  const s = setup();
  s.w.start();
  s.child.stdout.emit('data', Buffer.from(`GSCLIP\t2\tpublic.utf8-pl`));
  s.child.stdout.emit('data', Buffer.from(`ain-text\t${TERM}\n`));
  await s.flush();
  assert.deepEqual(s.spoken, ['hello']);
});

test('parseClipboardLine is strict', () => {
  assert.deepEqual(parseClipboardLine(`GSCLIP\t5\ta,b\t${TERM}`), { count: 5, types: ['a', 'b'], frontmost: TERM });
  assert.deepEqual(parseClipboardLine(`GSCLIP\t5\t\t${TERM}`), { count: 5, types: [], frontmost: TERM });
  assert.equal(parseClipboardLine('GSCLIP\t-1\ta\tx'), undefined);
  assert.equal(parseClipboardLine('GSCLIP\t1.5\ta\tx'), undefined);
});

// Own-copy gate (L33).
const fakeTui = (over: Record<string, unknown> = {}) => ({ getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => ['hola mundo'], ...over });

test('own-copy gate passes only when fullscreen, copyOnSelect, active selection and text on screen all hold', () => {
  assert.equal(createOwnCopyGate(() => fakeTui())('hola mundo'), true);
  assert.equal(createOwnCopyGate(() => undefined)('hola mundo'), false);
  assert.equal(createOwnCopyGate(() => ({ getScreenLines: () => ['hola mundo'] }))('hola mundo'), false, 'not fullscreen');
  assert.equal(createOwnCopyGate(() => fakeTui({ hasActiveSelection: 'yes' }))('hola mundo'), false, 'member must be a function');
  assert.equal(createOwnCopyGate(() => fakeTui({ getCopyOnSelect: () => false }))('hola mundo'), false);
  assert.equal(createOwnCopyGate(() => fakeTui({ hasActiveSelection: () => false }))('hola mundo'), false);
  assert.equal(createOwnCopyGate(() => fakeTui())('otro texto'), false);
  assert.equal(createOwnCopyGate(() => fakeTui({ getScreenLines: () => { throw new Error('boom'); } }))('hola mundo'), false);
});

test('own-copy gate strips ANSI and normalizes whitespace on both sides', () => {
  const tui = fakeTui({ getScreenLines: () => ['\u001b[1m\u001b[38;5;2mhola\u001b[0m   ', '  \u001b]8;;http://x\u0007mundo\u001b]8;;\u0007  fin'] });
  assert.equal(createOwnCopyGate(() => tui)('hola\n\n mundo\t'), true);
  assert.equal(createOwnCopyGate(() => tui)('mundo fin'), true);
  assert.equal(createOwnCopyGate(() => tui)('hola fin'), false);
  assert.equal(createOwnCopyGate(() => tui)('  \n '), false);
});

test('the watcher speaks only when isOwnCopy is true, after the frontmost and type checks', async () => {
  for (const own of [true, false]) {
    const child = new FakeChild();
    const spoken: string[] = [];
    const asked: string[] = [];
    const w = createCopiedSelectionWatcher({ terminalBundleId: TERM, spawn: () => child as never, readText: async () => ' abc ', speak: (t: string) => { spoken.push(t); }, isOwnCopy: (t: string) => { asked.push(t); return own; }, onError: () => {} });
    w.start();
    child.line(1, ['public.utf8-plain-text'], 'com.apple.Safari');
    child.line(2, ['org.nspasteboard.ConcealedType'], TERM);
    child.line(3, ['public.utf8-plain-text'], TERM);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(asked, ['abc']);
    assert.deepEqual(spoken, own ? ['abc'] : []);
  }
});

// L51: JXA console.log writes to stderr, while the watcher reads only stdout, so no line ever arrived.
test('the watcher script emits its lines on stdout, never through console.log', () => {
  assert.equal(typeof JXA_EMIT, 'string');
  assert.ok(WATCH_SCRIPT.startsWith(JXA_EMIT));
  assert.equal(WATCH_SCRIPT.includes('console.log'), false);
});

test('real osascript: the JXA emitter writes one parseable line to stdout and nothing to stderr', { skip: process.platform !== 'darwin' }, () => {
  const run = spawnSync('osascript', ['-l', 'JavaScript', '-e', `${JXA_EMIT}emit('GSCLIP\\t7\\tpublic.utf8-plain-text\\tcom.github.wez.wezterm');`], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, 'GSCLIP\t7\tpublic.utf8-plain-text\tcom.github.wez.wezterm\n');
  assert.deepEqual(parseClipboardLine(run.stdout.trimEnd()), { count: 7, types: ['public.utf8-plain-text'], frontmost: 'com.github.wez.wezterm' });
});

// L51: pi-tui copies a multi-row selection from the chat box only, while every screen row also holds the right rail.
const RAIL_SCREEN = [
  '   GIT:  On branch feat/gentle-speak      PATH:  /x/gentle-speak        │ - SPEAK ● on · modo todo │',
  '   MCP:  3 server(s)                      PLUGINS:  11 pac               │   on/off · copia ● ctrl+alt+c │',
];
const RAIL_COPY = 'On branch feat/gentle-speak      PATH:  /x/gentle-speak\n   MCP:  3 server(s)                      PLUGINS:  11 pac';
const selTui = (selection: unknown, o: Record<string, unknown> = {}) => ({
  getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => RAIL_SCREEN,
  getActiveSelectionText: typeof selection === 'function' ? selection : () => selection, ...o,
});

test('own-copy gate: a multi-row copy equal to the active selection text passes despite the rail', () => {
  assert.equal(createOwnCopyGate(() => selTui(RAIL_COPY))(RAIL_COPY), true);
});

test('own-copy gate: with a selection text, only an exact (normalized) match passes, not any on-screen text', () => {
  assert.equal(createOwnCopyGate(() => selTui('On branch feat/gentle-speak'))('3 server(s)'), false);
  assert.equal(createOwnCopyGate(() => selTui('On branch feat/gentle-speak'))('On  branch\nfeat/gentle-speak '), true);
  assert.equal(createOwnCopyGate(() => selTui(undefined))('On branch feat/gentle-speak'), false);
  assert.equal(createOwnCopyGate(() => selTui(() => { throw new Error('boom'); }))('On branch feat/gentle-speak'), false);
  assert.equal(createOwnCopyGate(() => selTui(RAIL_COPY, { hasActiveSelection: () => false }))(RAIL_COPY), false);
});

test('own-copy gate: a copy truncated to MAX_COPIED_CHARS passes when the selection starts with it', () => {
  const long = 'palabra '.repeat(700).trim();
  const copied = long.trim().slice(0, MAX_COPIED_CHARS); // exactly what the watcher hands the gate
  assert.equal(copied.length, MAX_COPIED_CHARS);
  assert.equal(createOwnCopyGate(() => selTui(long))(copied), true);
  assert.equal(createOwnCopyGate(() => selTui(long))('palabra palabra'), false);
});

test('own-copy gate fallback (no selection text getter): each copied line found on one screen row passes', () => {
  const tui = { getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => RAIL_SCREEN };
  assert.equal(createOwnCopyGate(() => tui)(RAIL_COPY), true);
  assert.equal(createOwnCopyGate(() => tui)('On branch feat/gentle-speak\nno está en pantalla'), false);
});

// L51: a multi-row copy carries newlines, which the speak path rejects as "Invalid speech text."
test('a multi-line copy is spoken as one line: newlines, tabs and control characters become single spaces', async () => {
  const s = setup({ text: '  On branch feat/gentle-speak   PATH: /x\n   MCP:\t3 server(s)\r\n\u0007fin  ' });
  s.w.start();
  s.child.line(9, ['public.utf8-plain-text'], TERM);
  await s.flush();
  assert.deepEqual(s.spoken, ['On branch feat/gentle-speak PATH: /x MCP: 3 server(s) fin']);
  assert.equal(/[\x00-\x1f]/.test(s.spoken[0]), false);
});
