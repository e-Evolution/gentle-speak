import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import { resolveDotSource, writeDotSpeak } from '../lib/speak-dot.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';

// T36: the L71 review advisories (R1-dot-package-source, R1-dot-speak-dir-mode, R3-001, R3-002, R4-001). Temp dirs only, fakes, no audio.
const quiet = (ms = 30) => new Promise(r => setTimeout(r, ms));
const until = async (cond: () => boolean, what = 'condition') => {
  const deadline = Date.now() + 5000;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 1)); }
};
const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'speak-t36-')); roots.push(dir); return dir; };
const pkg = (dir: string, name = 'gentle-speak') => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify({ name })); return dir; };
const settingsFile = (settings: Record<string, unknown>) => JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, ...settings });

// ---- R1-dot-package-source ----
function sourceWorld(terminalPackages: unknown[] | null) {
  const base = scratch(), home = join(base, 'home'), shell = join(base, 'shell');
  mkdirSync(shell, { recursive: true });
  if (terminalPackages) writeFileSync(join(shell, 'settings.json'), JSON.stringify({ packages: terminalPackages }));
  return { base, home, shell, io: { env: { PI_CODING_AGENT_DIR: shell }, home, packageRoot: pkg(join(base, 'root')) } };
}
test('R1-dot-package-source: a terminal entry that is an absolute local dir holding this package is written as is', () => {
  const w = sourceWorld(null); const good = pkg(join(w.base, 'dev', 'gentle-speak'));
  writeFileSync(join(w.shell, 'settings.json'), JSON.stringify({ packages: [good] }));
  assert.equal(resolveDotSource(w.io), good);
});
test('R1-dot-package-source: a relative or ~ entry is written absolute, and only when that dir exists and is this package', () => {
  const w = sourceWorld(['../dev/gentle-speak']); const good = pkg(join(w.base, 'dev', 'gentle-speak'));
  assert.equal(resolveDotSource(w.io), good);
  writeFileSync(join(w.shell, 'settings.json'), JSON.stringify({ packages: ['~/x/gentle-speak'] }));
  assert.equal(resolveDotSource(w.io), undefined, '~/x/gentle-speak does not exist');
});
test('R1-dot-package-source: a path that does not exist, or holds a different package, is refused', () => {
  const w = sourceWorld(['../missing/gentle-speak']);
  assert.equal(resolveDotSource(w.io), undefined);
  pkg(join(w.base, 'other', 'gentle-speak'), 'someone-else');
  writeFileSync(join(w.shell, 'settings.json'), JSON.stringify({ packages: ['../other/gentle-speak'] }));
  assert.equal(resolveDotSource(w.io), undefined);
  mkdirSync(join(w.base, 'nopkg', 'gentle-speak'), { recursive: true });
  writeFileSync(join(w.shell, 'settings.json'), JSON.stringify({ packages: ['../nopkg/gentle-speak'] }));
  assert.equal(resolveDotSource(w.io), undefined, 'no package.json');
});
test('R1-dot-package-source: only a well-formed npm spec for this package passes', () => {
  for (const spec of ['npm:gentle-speak', 'npm:gentle-speak@0.2.0', 'npm:gentle-speak@^1.0.0']) {
    const w = sourceWorld([spec]); assert.equal(resolveDotSource(w.io), spec);
  }
  for (const spec of ['npm:evil/gentle-speak', 'npm:@evil/gentle-speak', 'npm:gentle-speak@', 'npm:gentle-speak@1 2', 'git:github.com/x/gentle-speak', 'https://x.test/gentle-speak']) {
    const w = sourceWorld([spec]); assert.equal(resolveDotSource(w.io), undefined, spec);
  }
});
test('R1-dot-package-source: no terminal entry falls back to this package root when it is valid; an object entry keeps its extra keys', () => {
  const w = sourceWorld(null);
  assert.equal(resolveDotSource(w.io), resolve(w.io.packageRoot));
  const good = pkg(join(w.base, 'dev', 'gentle-speak'));
  writeFileSync(join(w.shell, 'settings.json'), JSON.stringify({ packages: [{ source: good, extensions: ['a'] }] }));
  assert.deepEqual(resolveDotSource(w.io), { source: good, extensions: ['a'] });
  assert.equal(resolveDotSource({ ...w.io, packageRoot: join(w.base, 'nowhere') , env: { PI_CODING_AGENT_DIR: join(w.base, 'empty') } }), undefined, 'an invalid fallback is refused too');
});

// ---- R1-dot-speak-dir-mode ----
const mode = (path: string) => statSync(path).mode & 0o777;
function modeWorld() {
  const base = scratch(), home = join(base, 'home'), dotHome = join(base, 'dot-home');
  mkdirSync(dotHome, { recursive: true }); chmodSync(dotHome, 0o755);
  return { dotHome, dir: join(dotHome, '.gentle-speak'), io: { env: { GENTLE_DOT_HOME: dotHome, GENTLE_DOT_AGENT_HOME: join(base, 'agent') }, home } };
}
const valid = () => ({ ...DEFAULT_SPEAK_SETTINGS, enabled: true });
test('R1-dot-speak-dir-mode: a new Dot speak dir is 0700', () => {
  const w = modeWorld(); writeDotSpeak(valid(), w.io);
  assert.equal(mode(w.dir), 0o700); assert.equal(mode(w.dotHome), 0o755);
});
test('R1-dot-speak-dir-mode: an existing 0755 dir holding only our settings file becomes 0700; Dot\'s own home is never touched', () => {
  const w = modeWorld(); mkdirSync(w.dir); writeFileSync(join(w.dir, 'speak-settings.json'), settingsFile({})); chmodSync(w.dir, 0o755);
  writeDotSpeak(valid(), w.io);
  assert.equal(mode(w.dir), 0o700); assert.equal(mode(w.dotHome), 0o755);
  assert.equal(mode(join(w.dir, 'speak-settings.json')), 0o600);
});
test('R1-dot-speak-dir-mode: an existing empty dir is ours too; one that holds another file keeps its mode', () => {
  const empty = modeWorld(); mkdirSync(empty.dir); chmodSync(empty.dir, 0o755); writeDotSpeak(valid(), empty.io);
  assert.equal(mode(empty.dir), 0o700);
  const foreign = modeWorld(); mkdirSync(foreign.dir); writeFileSync(join(foreign.dir, 'notes.txt'), 'x'); chmodSync(foreign.dir, 0o755);
  writeDotSpeak(valid(), foreign.io);
  assert.equal(mode(foreign.dir), 0o755); assert.deepEqual(readdirSync(foreign.dir).sort(), ['notes.txt', 'speak-settings.json']);
});

// ---- extension harness for the menu and home tests ----
type Opts = { terminalPackages?: unknown[]; dotSettings?: unknown; dotSpeak?: Record<string, unknown> | null; select?: string[]; listMac?: () => Promise<Array<{ name: string; locale: string }>>; speakHomeSame?: boolean; omit?: Array<'processHome' | 'speakHome'>; userOnly?: boolean; dotProcess?: boolean; voice?: string };
function world(o: Opts = {}) {
  const base = scratch(), userHome = join(base, 'home'), dotHomeDir = join(userHome, '.gentle-dot', 'home'), dot = join(userHome, '.gentle-dot', 'agent'), shell = join(userHome, '.gentle-shell', 'agent');
  const speakHome = join(base, 'speak'), dotSpeakDir = join(dotHomeDir, '.gentle-speak'), root = pkg(join(base, 'root'));
  for (const d of [speakHome, dot, shell, dotSpeakDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(speakHome, 'speak-settings.json'), settingsFile({ enabled: true, mode: 'all', voice: o.voice ?? 'es_MX' }));
  writeFileSync(join(dot, 'settings.json'), JSON.stringify(o.dotSettings ?? { theme: 'dot', packages: ['npm:pi-btw'] }, null, 2) + '\n');
  writeFileSync(join(shell, 'settings.json'), JSON.stringify({ packages: o.terminalPackages ?? [root] }));
  if (o.dotSpeak !== null) writeFileSync(join(dotSpeakDir, 'speak-settings.json'), settingsFile({ enabled: false, ...o.dotSpeak }));
  const events = new Map<string, Function>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const notes: string[] = [], selections = [...(o.select ?? [])], offered: string[][] = [], statuses: Array<string | undefined> = [], children: any[] = [];
  const ctx: any = { cwd: '/work/x', mode: 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [] },
    ui: { setStatus: (_k: string, t?: string) => statuses.push(t), setWidget() {}, notify: (t: string) => notes.push(t), confirm: async () => false, input: async () => undefined, select: async (_t: string, opts: string[]) => { offered.push(opts); return selections.shift(); } } };
  const spawn = () => { const c: any = Object.assign(new EventEmitter(), { writes: [] as string[], stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } }); c.stdin = { write: (l: string) => { c.writes.push(l); return true; } }; children.push(c); return c; };
  const homes: Record<string, unknown> = o.userOnly ? { userHome } : { userHome, processHome: o.dotProcess ? join(userHome, 'processhome') : userHome };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut() {}, registerTool: (t: any) => tools.set(t.name, t) } as any, o.userOnly ? undefined : speakHome, {
    env: { PI_CODING_AGENT_DIR: shell, GENTLE_DOT_AGENT_HOME: dot, GENTLE_DOT_HOME: dotHomeDir }, ...homes, packageRoot: root,
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn,
    focusCheck: async () => 'focused', focusPollMs: 5, lockPollMs: 5, sayAvailable: () => true, listMacVoices: o.listMac ?? (async () => [{ name: 'Paulina', locale: 'es_MX' }]),
    resolveTerminal: async () => undefined, qwenTmpRoot: base,
  } as any);
  return { base, userHome, speakHome, dot, shell, dotHomeDir, dotSpeakDir, root, ctx, notes, selections, offered, statuses, children, events, commands, tools,
    menu: () => commands.get('speak').handler('', ctx),
    dotFile: () => readFileSync(join(dot, 'settings.json'), 'utf8'), backups: () => readdirSync(dot).filter(n => n.includes('backup')),
    dotSpeak: () => JSON.parse(readFileSync(join(dotSpeakDir, 'speak-settings.json'), 'utf8')) };
}

test('R1-dot-package-source (menu): Conectar refuses a terminal entry that points at a different package: notice, nothing written, no backup', async () => {
  const base0 = scratch(); const other = pkg(join(base0, 'gentle-speak'), 'not-this');
  const w = world({ terminalPackages: [other] }); const before = w.dotFile();
  w.selections.push('Gentle Dot', 'Conectar Gentle Dot'); await w.menu(); await quiet();
  assert.equal(w.dotFile(), before); assert.deepEqual(w.backups(), []);
  assert.ok(w.notes.some(t => /paquete|package/i.test(t) && /gentle-speak/.test(t)), `a notice names the refusal: ${JSON.stringify(w.notes)}`);
  assert.equal(w.dotSpeak().enabled, false, 'Dot speech is not enabled by a refused connect');
});
test('R1-dot-package-source (menu): Conectar writes exactly the validated absolute source', async () => {
  const w = world(); w.selections.push('Gentle Dot', 'Conectar Gentle Dot'); await w.menu(); await quiet();
  assert.deepEqual(JSON.parse(w.dotFile()).packages, ['npm:pi-btw', w.root]); assert.equal(w.backups().length, 1); assert.equal(w.dotSpeak().enabled, true);
});

// ---- R3-001: the Gentle Dot submenu used a snapshot taken before the human chose ----
test('R3-001: Desconectar keeps what Dot\'s speak settings changed while the menu was open (no stale overwrite)', async () => {
  const w = world({ dotSettings: { packages: ['npm:pi-btw', '/x/gentle-speak'] }, dotSpeak: { enabled: true, voice: 'es_MX', mode: 'all' } });
  w.ctx.ui.select = async (_t: string, opts: string[]) => {
    if (opts.includes('Desconectar Gentle Dot')) writeFileSync(join(w.dotSpeakDir, 'speak-settings.json'), settingsFile({ enabled: true, voice: 'es_ES', mode: 'summary' }));
    return opts.includes('Desconectar Gentle Dot') ? 'Desconectar Gentle Dot' : 'Gentle Dot';
  };
  await w.menu(); await quiet();
  assert.deepEqual(JSON.parse(w.dotFile()).packages, ['npm:pi-btw']);
  assert.deepEqual({ enabled: w.dotSpeak().enabled, voice: w.dotSpeak().voice, mode: w.dotSpeak().mode }, { enabled: false, voice: 'es_ES', mode: 'summary' });
});
test('R3-001: Desconectar re-checks Dot after the choice: a Dot that disappeared meanwhile changes nothing', async () => {
  const w = world({ dotSettings: { packages: ['/x/gentle-speak'] }, dotSpeak: { enabled: true } });
  w.ctx.ui.select = async (_t: string, opts: string[]) => { if (!opts.includes('Desconectar Gentle Dot')) return 'Gentle Dot'; rmSync(join(w.dot, 'settings.json')); return 'Desconectar Gentle Dot'; };
  await w.menu(); await quiet();
  assert.equal(w.dotSpeak().enabled, true, 'nothing was written for an absent Dot');
  assert.ok(w.notes.some(t => /No encontré Gentle Dot/.test(t)));
});
test('R3-001 preserve: Desconectar removes only our entry and sets enabled false, Dot\'s file is kept', async () => {
  const w = world({ dotSettings: { keep: 1, packages: ['npm:pi-btw', '/x/gentle-speak', 'npm:gentle-engram'] }, dotSpeak: { enabled: true, voice: 'es_ES' } });
  w.selections.push('Gentle Dot', 'Desconectar Gentle Dot'); await w.menu(); await quiet();
  assert.deepEqual(JSON.parse(w.dotFile()), { keep: 1, packages: ['npm:pi-btw', 'npm:gentle-engram'] });
  assert.deepEqual({ enabled: w.dotSpeak().enabled, voice: w.dotSpeak().voice }, { enabled: false, voice: 'es_ES' });
});

// ---- R3-002: homes ----
test('R3-002: a process home that differs from the user home (Dot) wins over an injected speakHome for the settings; assets and the lock stay in speakHome', async () => {
  const w = world({ dotSpeak: null, dotProcess: true });
  const settingsDir = join(w.userHome, 'processhome', '.gentle-speak'); mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'speak-settings.json'), settingsFile({ enabled: true, mode: 'all', voice: 'es_ES' }));
  w.selections.push('Gentle Dot'); await w.menu(); // any menu read goes through the resolved settings dir
  const run = w.tools.get('speak').execute('id', { text: 'Hola mundo.' }, undefined, undefined, w.ctx);
  await until(() => w.children.some(c => c.writes.length), 'worker write');
  assert.equal(JSON.parse(w.children.find(c => c.writes.length).writes[0]).model.name, 'es_ES-davefx-medium.onnx', 'settings came from the process home');
  assert.ok(existsSync(join(w.speakHome, 'voice.lock')), 'the voice lock is in the shared speakHome');
  const c = w.children.find(c => c.writes.length); c.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: JSON.parse(c.writes[0]).id }) + '\n'); await run;
});
test('R3-002: with only userHome injected nothing falls back to the real $HOME: settings and assets live under userHome/.gentle-speak', async () => {
  const w = world({ userOnly: true });
  const dir = join(w.userHome, '.gentle-speak'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'speak-settings.json'), settingsFile({ enabled: true, mode: 'all', voice: 'es_ES' }));
  const run = w.tools.get('speak').execute('id', { text: 'Hola mundo.' }, undefined, undefined, w.ctx);
  await until(() => w.children.some(c => c.writes.length), 'worker write');
  assert.equal(JSON.parse(w.children.find(c => c.writes.length).writes[0]).model.name, 'es_ES-davefx-medium.onnx');
  assert.ok(existsSync(join(dir, 'voice.lock')));
  const c = w.children.find(c => c.writes.length); c.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: JSON.parse(c.writes[0]).id }) + '\n'); await run;
});

// ---- R4-001: the Mac voice list ----
const VOICES = [{ name: 'Paulina', locale: 'es_MX' }, { name: 'Mónica', locale: 'es_ES' }];
test('R4-001: concurrent callers share one in-flight probe instead of each spawning `say -v ?`', async () => {
  let calls = 0, release: (v: typeof VOICES) => void = () => {};
  const w = world({ voice: 'mac', listMac: () => { calls++; return new Promise(r => { release = r; }); } });
  const a = w.events.get('session_start')!({}, w.ctx), b = w.events.get('session_start')!({}, w.ctx);
  await quiet(10); release(VOICES); await Promise.all([a, b]); await quiet();
  assert.equal(calls, 1);
});
test('R4-001: a failed or empty re-list (the voice picker) keeps the last good list instead of wiping it', async () => {
  let phase: 'good' | 'empty' | 'throw' = 'good';
  const w = world({ voice: 'mac', listMac: async () => { if (phase === 'throw') throw new Error('say failed'); return phase === 'good' ? VOICES : []; } });
  await w.events.get('session_start')!({}, w.ctx);
  phase = 'empty'; w.selections.push('Mac voice', 'Mónica'); await w.menu(); // the picker re-lists: empty, so the cached list is offered
  assert.ok(w.offered.some(o => o[0] === 'Auto' && o.includes('Paulina') && o.includes('Mónica')), `picker offered ${JSON.stringify(w.offered)}`);
  phase = 'throw'; w.offered.length = 0; w.selections.push('Mac voice', 'Auto'); await w.menu();
  assert.ok(w.offered.some(o => o[0] === 'Auto' && o.includes('Paulina')), 'a throwing probe also keeps the cache');
});
