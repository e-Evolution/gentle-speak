import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, readSpeakSettings } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';

// S12 wiring: speaking in Dot's root RPC session, the one-time offer and the /speak connect/disconnect. All fakes, temp dirs, no audio.
const until = async (cond: () => boolean, what = 'condition') => {
  const deadline = Date.now() + 5000;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 1)); }
};
const quiet = (ms = 30) => new Promise(r => setTimeout(r, ms));
const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const msg = (text: string) => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }];

type Opts = { mode?: string; header?: any; as?: 'dot' | 'shell' | 'other' | { GENTLE_SPEAK_DOT: string }; speak?: Record<string, unknown>; dotSettings?: string | null; terminalPackages?: unknown[]; confirm?: boolean; focus?: string; text?: string; select?: string[] };
function world(o: Opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'speak-dot-wiring-')); roots.push(base);
  const userHome = join(base, 'home'), speakHome = join(base, 'speak'), dot = join(userHome, '.gentle-dot', 'agent'), shell = join(userHome, '.gentle-shell', 'agent');
  for (const d of [speakHome, dot, shell]) mkdirSync(d, { recursive: true });
  writeFileSync(join(speakHome, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all', ...o.speak }));
  if (o.dotSettings !== null) writeFileSync(join(dot, 'settings.json'), o.dotSettings ?? JSON.stringify({ theme: 'dot', packages: ['npm:pi-btw'] }, null, 2) + '\n');
  writeFileSync(join(shell, 'settings.json'), JSON.stringify({ packages: o.terminalPackages ?? ['npm:pi-btw', '../../dev/gentle-speak'] }));
  // The process env decides the session's agent dir: Dot's engine home, the terminal's, or an unrelated one.
  const env: Record<string, string | undefined> = o.as === 'dot' ? { PI_CODING_AGENT_DIR: dot, GENTLE_DOT_AGENT_HOME: dot } : o.as === 'other' ? { PI_CODING_AGENT_DIR: join(base, 'other-agent') } : typeof o.as === 'object' ? { PI_CODING_AGENT_DIR: join(base, 'other-agent'), ...o.as } : { PI_CODING_AGENT_DIR: shell };
  // T34: Dot keeps its own settings under its HOME; assets and the lock stay in the shared (speak) home.
  const isDot = o.as === 'dot' || typeof o.as === 'object', dotSpeakDir = join(userHome, '.gentle-dot', 'home', '.gentle-speak');
  if (isDot) { mkdirSync(dotSpeakDir, { recursive: true }); writeFileSync(join(dotSpeakDir, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all', ...o.speak })); }
  const state = { branch: msg(o.text ?? 'Resultado listo.'), checks: 0, focus: o.focus ?? 'focused' };
  const children: any[] = [], events = new Map<string, Function>(), tools = new Map<string, any>(), shortcuts = new Map<string, any>(), commands = new Map<string, any>();
  const ui: string[] = [], notes: string[] = [], confirms: string[] = [], selections = [...(o.select ?? [])];
  const spawn = () => {
    const c: any = Object.assign(new EventEmitter(), { writes: [] as string[], stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } });
    c.stdin = { write: (l: string) => { c.writes.push(l); return true; } }; children.push(c); return c;
  };
  const spied = (name: string) => (..._a: any[]) => { ui.push(name); };
  const ctx: any = { cwd: '/work/x', mode: o.mode ?? 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => o.header ?? { type: 'session' }, getBranch: () => state.branch },
    ui: { setStatus: spied('setStatus'), setWidget: spied('setWidget'), setTitle: spied('setTitle'), input: async () => { ui.push('input'); return undefined; },
      notify: (t: string) => notes.push(t), confirm: async (_t: string, m: string) => { confirms.push(m); return o.confirm ?? false; }, select: async () => selections.shift() } };
  const watchers: any[] = [];
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut: (k: string, s: any) => shortcuts.set(k, s), registerTool: (t: any) => tools.set(t.name, t) } as any, speakHome, {
    ...(isDot ? { settingsHome: dotSpeakDir } : {}),
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn,
    focusCheck: async () => { state.checks++; return state.focus as any; }, focusPollMs: 5, lockPollMs: 5, sayAvailable: () => false,
    env, userHome, packageRoot: '/pkg/gentle-speak', resolveTerminal: async () => 'com.t', createWatcher: ((w: any) => { watchers.push(w); return { start() {}, stop() {} }; }) as any,
  } as any);
  const settle = () => events.get('agent_settled')!({ aborted: false }, ctx);
  const texts = () => children.filter(c => c.writes.length).map(c => JSON.parse(c.writes[0]).text);
  const finish = (c: any) => c.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: JSON.parse(c.writes[0]).id }) + '\n');
  const startRaw = () => events.get('session_start')!({ reason: 'startup' }, ctx);
  // The offer runs in the background after session_start returns: let that timer and its microtasks run.
  const start = async () => { await startRaw(); await new Promise(r => setTimeout(r, 5)); };
  return { base, userHome, speakHome, dot, shell, ctx, ui, notes, confirms, state, children, events, tools, shortcuts, commands, watchers, settle, texts, finish, start, startRaw, selections,
    dotFile: () => readFileSync(join(dot, 'settings.json'), 'utf8'), dotBackups: () => readdirSync(dot).filter(n => n.includes('gentle-speak-backup')), speakSettings: () => readSpeakSettings(speakHome), dotSpeak: () => JSON.parse(readFileSync(join(dotSpeakDir0(userHome), 'speak-settings.json'), 'utf8')), dotSpeakExists: () => existsSync(join(dotSpeakDir0(userHome), 'speak-settings.json')), shutdown: () => events.get('session_shutdown')!({}, ctx) };
}
const dotSpeakDir0 = (userHome: string) => join(userHome, '.gentle-dot', 'home', '.gentle-speak');
const rpcDot = (o: Opts = {}) => world({ mode: 'rpc', as: 'dot', ...o, speak: { dotSpeech: true, ...o.speak } });

test('Dot root RPC session speaks `Dot: <text>` at once (no focus deferral, even when unfocused), holding the voice lock', async () => {
  const w = rpcDot({ focus: 'unfocused' });
  const p = w.settle(); await until(() => w.texts().length === 1, 'speech');
  assert.deepEqual(w.texts(), ['Dot: Resultado listo.']);
  assert.equal(w.state.checks, 0, 'the focus check is never consulted');
  assert.ok(existsSync(join(w.speakHome, 'voice.lock')), 'the cross-process voice lock is held during playback');
  w.finish(w.children[0]); await p; await until(() => !existsSync(join(w.speakHome, 'voice.lock')), 'lock released');
  w.shutdown();
});

test('Dot speaks with the same mode filter (questions-and-results drops chatter) and the manual speak tool also carries the prefix', async () => {
  const w = rpcDot({ speak: { mode: 'questions-and-results' }, text: 'Voy a revisar el archivo.' });
  await w.settle(); await quiet(); assert.deepEqual(w.children, [], 'S1 filter: plain narration is not spoken');
  const run = w.tools.get('speak').execute('id', { text: 'Hola' }, undefined, undefined, w.ctx); await until(() => w.texts().length === 1, 'tool speech');
  assert.deepEqual(w.texts(), ['Dot: Hola']); w.finish(w.children[0]); assert.equal((await run).isError, undefined); w.shutdown();
});

test('GENTLE_SPEAK_DOT=1 qualifies a root RPC session whose agent dir is elsewhere', async () => {
  const w = world({ mode: 'rpc', as: { GENTLE_SPEAK_DOT: '1' }, speak: { dotSpeech: true } });
  const p = w.settle(); await until(() => w.texts().length === 1); assert.deepEqual(w.texts(), ['Dot: Resultado listo.']); w.finish(w.children[0]); await p; w.shutdown();
});

for (const [name, o] of [
  ['another RPC client (agent dir is not Dot\'s)', { mode: 'rpc', as: 'other', speak: { dotSpeech: true } }],
  ['a Dot child session (has a parent session)', { mode: 'rpc', as: 'dot', header: { type: 'session', parentSession: '/p.jsonl' }, speak: { dotSpeech: true } }],
  ['print mode in Dot\'s home', { mode: 'print', as: 'dot', speak: { dotSpeech: true } }],
  ['json mode in Dot\'s home', { mode: 'json', as: 'dot', speak: { dotSpeech: true } }],
  ['Dot root RPC whose own settings are not enabled (the terminal dotSpeech is irrelevant)', { mode: 'rpc', as: 'dot', speak: { enabled: false, dotSpeech: true } }],
  ['RPC in the terminal agent dir', { mode: 'rpc', as: 'shell', speak: { dotSpeech: true } }],
] as Array<[string, Opts]>) test(`never speaks: ${name}`, async () => {
  const w = world(o);
  await w.settle(); await quiet();
  const tool = await w.tools.get('speak').execute('id', { text: 'Hola' }, undefined, undefined, w.ctx);
  assert.equal(tool.isError, true); assert.deepEqual(w.children, []); assert.equal(existsSync(join(w.speakHome, 'voice.lock')), false); w.shutdown();
});

test('an RPC session never touches the SPEAK row, the copy watcher, widgets, input or shortcuts', async () => {
  const w = rpcDot({ speak: { copySpeech: true } });
  await w.start();
  for (const [, shortcut] of w.shortcuts) await shortcut.handler(w.ctx);
  await w.commands.get('speak').handler('', w.ctx);
  const turn = w.settle(); await until(() => w.texts().length === 1); w.finish(w.children[0]); await turn; await quiet();
  w.shutdown();
  assert.deepEqual(w.ui, [], 'no setStatus/setWidget/input/title call from an RPC session');
  assert.deepEqual(w.watchers, [], 'no copy watcher');
  assert.deepEqual(w.confirms, [], 'no offer');
  assert.equal(w.texts().length, 1, 'the shortcuts spoke nothing besides the automatic turn');
});

test('preserve: the terminal parent still defers when unfocused and speaks without a prefix', async () => {
  const w = world({ focus: 'unfocused', speak: { dotSpeech: true } });
  await w.settle(); await quiet(); assert.deepEqual(w.children, []);
  w.state.focus = 'focused'; await until(() => w.texts().length === 1, 'speech after focus');
  assert.deepEqual(w.texts(), ['Resultado listo.']); w.finish(w.children[0]); w.shutdown();
});

test('offer: yes connects (backup, package entry re-resolved for Dot, other keys kept, own Dot settings enabled) and is not asked again', async () => {
  const w = world({ confirm: true });
  const before = w.dotFile();
  await w.start();
  assert.deepEqual(w.confirms, ['Encontré Gentle Dot. ¿Querés que también hable ahí?']);
  assert.equal(w.dotBackups().length, 1); assert.equal(readFileSync(join(w.dot, w.dotBackups()[0]), 'utf8'), before);
  assert.equal(w.dotFile(), `${JSON.stringify({ theme: 'dot', packages: ['npm:pi-btw', resolve(w.shell, '../../dev/gentle-speak')] }, null, 2)}\n`);
  assert.equal(w.dotSpeak().enabled, true); assert.equal(w.dotSpeak().copySpeech, false);
  assert.ok(w.notes.includes('Gentle Dot conectado: silenciá la voz propia de Dot y reinicialo.'));
  await w.start(); assert.equal(w.confirms.length, 1, 'already connected: nothing more to ask'); assert.equal(w.dotBackups().length, 1);
  w.shutdown();
});

test('offer: an npm source is copied as is', async () => {
  const w = world({ confirm: true, terminalPackages: ['npm:gentle-speak@0.3.0'] });
  await w.start(); assert.deepEqual(JSON.parse(w.dotFile()).packages, ['npm:pi-btw', 'npm:gentle-speak@0.3.0']); w.shutdown();
});

test('offer: no persists dotOffer "declined", leaves Dot untouched and never asks again', async () => {
  const w = world({ confirm: false });
  const before = w.dotFile();
  await w.start();
  assert.equal(w.confirms.length, 1); assert.equal(w.speakSettings().dotOffer, 'declined'); assert.equal(w.dotSpeakExists(), false);
  assert.equal(w.dotFile(), before); assert.deepEqual(w.dotBackups(), []);
  await w.start(); assert.equal(w.confirms.length, 1); w.shutdown();
});

test('offer: nothing to ask when Dot has no settings.json', async () => {
  const w = world({ confirm: true, dotSettings: null });
  await w.start(); assert.deepEqual(w.confirms, []); assert.equal(existsSync(join(w.dot, 'settings.json')), false); w.shutdown();
});

test('offer: a malformed Dot settings.json is never written; the user is told once', async () => {
  const w = world({ confirm: true, dotSettings: '{"packages": [oops' });
  await w.start(); await w.start();
  assert.deepEqual(w.confirms, []); assert.equal(w.dotFile(), '{"packages": [oops'); assert.deepEqual(w.dotBackups(), []);
  assert.equal(w.notes.filter(n => /mal formado/.test(n)).length, 1); assert.equal(w.speakSettings().dotOffer, null); w.shutdown();
});

for (const [name, o] of [
  ['inside Dot\'s own engine (TUI)', { as: 'dot' }],
  ['a child session', { header: { type: 'session', parentSession: '/p.jsonl' } }],
  ['an RPC session', { mode: 'rpc' }],
  ['a print session', { mode: 'print' }],
  ['GENTLE_SPEAK_DOT=1', { as: { GENTLE_SPEAK_DOT: '1' } }],
] as Array<[string, Opts]>) test(`no offer ${name}`, async () => {
  const w = world({ confirm: true, ...o }); const before = w.dotFile();
  await w.start(); assert.deepEqual(w.confirms, []); assert.equal(w.dotFile(), before); assert.deepEqual(w.dotBackups(), []); w.shutdown();
});

test('the offer writes through a temp file and rename, never in place', async () => {
  const renames: string[] = [];
  const w = world({ confirm: true });
  // Rebuild with an fs spy: the same tree, observing renames of Dot\'s settings.
  const spy = { ...fs, renameSync: (a: any, b: any) => { renames.push(`${a}=>${b}`); return fs.renameSync(a, b); } } as any;
  const events = new Map<string, Function>();
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool() {} } as any, w.speakHome, { env: { PI_CODING_AGENT_DIR: w.shell }, userHome: w.userHome, dotFs: spy, packageRoot: '/pkg', sayAvailable: () => false, focusCheck: async () => 'focused', resolveTerminal: async () => undefined } as any);
  await events.get('session_start')!({}, w.ctx); await quiet(20);
  assert.equal(renames.length, 2, 'Dot settings.json and Dot speak settings'); assert.match(renames.find(r => /gentle-dot\/agent/.test(r))!, new RegExp(`settings\\.json\\.[^/]+\\.tmp=>${w.dot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/settings\\.json$`));
  w.shutdown();
});

const menu = async (w: ReturnType<typeof world>, choice: string) => { w.selections.push(...(choice === 'Cancel' ? [choice] : ['Gentle Dot', choice])); await w.commands.get('speak').handler('', w.ctx); };

test('/speak shows the Dot state and « Conectar Gentle Dot » connects without asking', async () => {
  const w = world({ confirm: false, speak: { dotOffer: 'declined' } });
  let offered: string[] = []; const select = w.ctx.ui.select; w.ctx.ui.select = async (t: string, items: string[]) => { offered = items; return select(t, items); };
  await menu(w, 'Conectar Gentle Dot');
  assert.equal(offered[0], 'Gentle Dot: no conectado · habla: no · voz sin configurar · modo sin configurar');
  assert.deepEqual(w.confirms, []); assert.equal(w.dotBackups().length, 1); assert.ok(JSON.parse(w.dotFile()).packages.includes(resolve(w.shell, '../../dev/gentle-speak')));
  assert.equal(w.dotSpeak().enabled, true); assert.ok(w.notes.includes('Gentle Dot conectado: silenciá la voz propia de Dot y reinicialo.'));
  w.selections.push('Gentle Dot', 'Volver'); await w.commands.get('speak').handler('', w.ctx); assert.equal(offered[0], 'Gentle Dot: conectado · habla: sí · voz es_MX · modo all'); w.shutdown();
});

test('/speak « Desconectar Gentle Dot » backs up, removes only our entry and sets Dot\'s own enabled off', async () => {
  const w = world({ confirm: true, dotSettings: JSON.stringify({ keep: 1, packages: ['npm:pi-btw', '/x/gentle-speak', 'npm:gentle-engram'] }, null, 2) + '\n' });
  mkdirSync(dotSpeakDir0(w.userHome), { recursive: true }); writeFileSync(join(dotSpeakDir0(w.userHome), 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true }));
  await menu(w, 'Desconectar Gentle Dot');
  assert.deepEqual(JSON.parse(w.dotFile()), { keep: 1, packages: ['npm:pi-btw', 'npm:gentle-engram'] });
  assert.equal(w.dotBackups().length, 1); assert.equal(w.dotSpeak().enabled, false); w.shutdown();
});

test('/speak connect refuses a malformed Dot settings.json without writing', async () => {
  const w = world({ dotSettings: '[]' });
  await menu(w, 'Conectar Gentle Dot');
  assert.equal(w.dotFile(), '[]'); assert.deepEqual(w.dotBackups(), []); assert.equal(w.dotSpeakExists(), false); assert.ok(w.notes.some(n => /mal formado/.test(n))); w.shutdown();
});

// Review fix: the offer runs in the background, never inside `session_start`.
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test('offer: session_start resolves while the confirm is still pending; the answer is applied afterwards', async () => {
  const w = world({ confirm: true });
  const answer = deferred<boolean>();
  w.ctx.ui.confirm = async (_t: string, m: string) => { w.confirms.push(m); return answer.promise; };
  const before = w.dotFile();
  const outcome = await Promise.race([w.startRaw().then(() => 'resolved'), quiet(300).then(() => 'blocked')]);
  assert.equal(outcome, 'resolved', 'startup does not wait for the human');
  await until(() => w.confirms.length === 1, 'offer shown in the background');
  assert.equal(w.dotFile(), before, 'nothing written before the answer');
  answer.resolve(true);
  await until(() => w.dotBackups().length === 1, 'answer applied');
  assert.deepEqual(JSON.parse(w.dotFile()).packages.length, 2); assert.equal(w.dotSpeak().enabled, true);
  await w.start(); assert.equal(w.confirms.length, 1); w.shutdown();
});

test('offer: shutdown before the answer writes nothing', async () => {
  const w = world({ confirm: true });
  const answer = deferred<boolean>();
  w.ctx.ui.confirm = async (_t: string, m: string) => { w.confirms.push(m); return answer.promise; };
  const before = w.dotFile();
  await w.startRaw(); await until(() => w.confirms.length === 1, 'offer shown');
  w.shutdown(); answer.resolve(true); await quiet(50);
  assert.equal(w.dotFile(), before); assert.deepEqual(w.dotBackups(), []); assert.equal(w.dotSpeakExists(), false); assert.equal(w.speakSettings().dotOffer, null);
});

test('offer: a second session_start in the same process never shows it twice while the first is pending', async () => {
  const w = world({ confirm: true });
  const answer = deferred<boolean>();
  w.ctx.ui.confirm = async (_t: string, m: string) => { w.confirms.push(m); return answer.promise; };
  await w.startRaw(); await w.startRaw(); await quiet(50);
  assert.equal(w.confirms.length, 1); answer.resolve(false); await until(() => w.speakSettings().dotOffer === 'declined'); w.shutdown();
});

test('offer: a confirm that rejects is swallowed and a write failure is notified once', async () => {
  const w = world({ confirm: true });
  w.ctx.ui.confirm = async () => { throw new Error('dialog gone'); };
  await w.startRaw(); await quiet(50); assert.deepEqual(w.notes, []); w.shutdown();
  const f = world({ confirm: true, dotSettings: JSON.stringify({ packages: [] }) });
  const events = new Map<string, Function>();
  const failing = { ...fs, writeFileSync: (p: any, ...rest: any[]) => { if (String(p).includes('.tmp')) throw new Error('disk full'); return (fs.writeFileSync as any)(p, ...rest); } } as any;
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool() {} } as any, f.speakHome, { env: { PI_CODING_AGENT_DIR: f.shell }, userHome: f.userHome, dotFs: failing, packageRoot: '/pkg', sayAvailable: () => false, focusCheck: async () => 'focused', resolveTerminal: async () => undefined } as any);
  await events.get('session_start')!({}, f.ctx); await until(() => f.notes.length > 0, 'write failure notified'); await quiet(30);
  assert.deepEqual(f.notes, ['No pude actualizar el settings.json de Gentle Dot; nada cambió.']); f.shutdown();
});

test('hermetic guard: with an injected HOME and fs, no fs call touches the real Dot paths', async () => {
  const { homedir } = await import('node:os');
  const real = homedir(), seen: string[] = [];
  const spy: any = {}; for (const k of ['readFileSync', 'writeFileSync', 'renameSync', 'copyFileSync', 'existsSync', 'unlinkSync', 'mkdirSync']) spy[k] = (...a: any[]) => { seen.push(String(a[0])); return (fs as any)[k](...a); };
  const w = world({ dotSettings: null, confirm: true });
  const events = new Map<string, Function>(), commands = new Map<string, any>();
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut() {}, registerTool() {} } as any, w.speakHome, { env: {}, userHome: w.userHome, dotFs: spy, packageRoot: '/pkg', sayAvailable: () => false, focusCheck: async () => 'focused', resolveTerminal: async () => undefined } as any);
  await events.get('session_start')!({}, w.ctx); await quiet(30);
  w.selections.push('Conectar Gentle Dot'); await commands.get('speak').handler('', w.ctx); await quiet(30);
  assert.ok(seen.length > 0, 'the injected fs was used');
  assert.deepEqual(seen.filter(p => !p.startsWith(w.userHome)), [], 'only paths under the injected HOME');
  assert.deepEqual(seen.filter(p => p.startsWith(join(real, '.gentle-dot'))), []); w.shutdown();
});
