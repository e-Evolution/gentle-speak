import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';

// S9 wiring: focus deferral, one voice across sessions (shared lock dir), project prefix. All fakes; no herdr, osascript or audio.
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const msg = (text: string) => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } }];
const keys = DEFAULT_SPEAK_SETTINGS.shortcuts;
const roots: string[] = [];
const sharedHome = () => { const h = mkdtempSync(join(tmpdir(), 'speak-wiring-')); roots.push(h); return h; };
const save = (home: string, patch: Record<string, unknown> = {}) => writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all', ...patch }));
const lockHeld = (home: string) => existsSync(join(home, 'voice.lock'));

function session(home: string, opts: { focus?: () => string | Promise<string>; text?: string; cwd?: string; deps?: any; mode?: string } = {}) {
  const state = { focus: 'focused', branch: msg(opts.text ?? 'Resultado listo.'), checks: 0 };
  const children: any[] = [];
  const shortcuts = new Map<string, any>(); const events = new Map<string, Function>(); const tools = new Map<string, any>();
  const spawn = () => {
    const c: any = Object.assign(new EventEmitter(), { writes: [] as string[], killed: 0, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.killed++; return true; } });
    c.stdin = { write: (l: string) => { c.writes.push(l); return true; } };
    children.push(c); return c;
  };
  const notes: string[] = [];
  const ctx: any = { cwd: opts.cwd ?? '/work/gentle-theme', mode: opts.mode ?? 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => state.branch },
    ui: { setStatus() {}, notify: (t: string) => notes.push(t), confirm: async () => false, select: async () => undefined, input: async () => undefined } };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut: (k: string, s: any) => shortcuts.set(k, s), registerTool: (t: any) => tools.set(t.name, t) } as any, home, {
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn,
    focusCheck: opts.focus ?? (async () => { state.checks++; return state.focus as any; }), focusPollMs: 5, lockPollMs: 5, ...opts.deps } as any);
  const settle = () => events.get('agent_settled')!({ aborted: false }, ctx);
  const finish = (c: any) => c.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: JSON.parse(c.writes[0]).id }) + '\n');
  const texts = () => children.filter(c => c.writes.length).map(c => JSON.parse(c.writes[0]).text);
  const tool = (text: string, signal?: AbortSignal) => tools.get('speak').execute('id', { text }, signal, undefined, ctx);
  return { state, children, shortcuts, events, ctx, notes, settle, finish, texts, tool, shutdown: () => events.get('session_shutdown')!({}, ctx) };
}
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

test('focused: automatic speech plays at once with the exact text', async () => {
  const home = sharedHome(); save(home); const s = session(home);
  const p = s.settle(); await sleep(15);
  assert.deepEqual(s.texts(), ['Resultado listo.']);
  s.finish(s.children[0]); await p; s.shutdown();
});

test('unfocused: nothing plays, then exactly once after focus arrives; polling stops afterwards', async () => {
  const home = sharedHome(); save(home); const s = session(home); s.state.focus = 'unfocused';
  const p = s.settle(); await p; await sleep(40);
  assert.deepEqual(s.children, []);
  assert.ok(s.state.checks > 1, 'polls while an item is pending');
  s.state.focus = 'focused'; await sleep(40);
  assert.deepEqual(s.texts(), ['Resultado listo.']);
  const after = s.state.checks; await sleep(40);
  assert.equal(s.state.checks, after, 'no polling once nothing is pending');
  assert.equal(s.children.length, 1);
  s.finish(s.children[0]); s.shutdown();
});

test('two unfocused results leave only the latest, spoken once', async () => {
  const home = sharedHome(); save(home); const s = session(home, { text: 'Primero.' }); s.state.focus = 'unfocused';
  await s.settle(); s.state.branch = msg('Segundo.'); await s.settle(); s.state.branch = msg('Tercero.'); await s.settle();
  s.state.focus = 'focused'; await sleep(40);
  assert.deepEqual(s.texts(), ['Tercero.']);
  await sleep(30); assert.equal(s.children.length, 1);
  s.finish(s.children[0]); s.shutdown();
});

test('unknown focus speaks in turn with the exact "<basename>: " prefix', async () => {
  const home = sharedHome(); save(home); const s = session(home, { cwd: '/home/u/gentle-theme/' }); s.state.focus = 'unknown';
  const p = s.settle(); await sleep(15);
  assert.deepEqual(s.texts(), ['gentle-theme: Resultado listo.']);
  s.finish(s.children[0]); await p; s.shutdown();
});

test('the model-callable speak tool: focused speaks and returns the outcome; unfocused defers then speaks once; unknown prefixes', async () => {
  const home = sharedHome(); save(home); const s = session(home);
  const a = s.tool('Hola ahora'); await sleep(15);
  assert.deepEqual(s.texts(), ['Hola ahora']);
  s.finish(s.children[0]); assert.equal((await a).isError, undefined); assert.equal((await a).content[0].text, 'Speech completed.');
  s.state.focus = 'unfocused';
  const b = await s.tool('Hola luego');
  assert.equal(b.isError, undefined); assert.match(b.content[0].text, /deferred/i); assert.equal(s.children.length, 1);
  s.state.focus = 'focused'; await sleep(40);
  assert.deepEqual(s.texts(), ['Hola ahora', 'Hola luego']);
  s.finish(s.children[1]); await sleep(10);
  s.state.focus = 'unknown';
  const c = s.tool('Hola turno'); await sleep(15);
  assert.equal(JSON.parse(s.children[2].writes[0]).text, 'gentle-theme: Hola turno');
  s.finish(s.children[2]); await c; s.shutdown();
});

test('speak-last and copy speech bypass the deferral (but not the single voice)', async () => {
  const home = sharedHome(); save(home, { copySpeech: true });
  const watchers: any[] = [];
  const s = session(home, { deps: { resolveTerminal: async () => 'com.term', createWatcher: (o: any) => { watchers.push(o); return { start() {}, stop() {} }; } } });
  (s.ctx.ui as any).setWidget = (_k: string, f: any) => { f({ getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => [] }, {}); };
  s.state.focus = 'unfocused';
  await s.events.get('session_start')!({ reason: 'startup' }, s.ctx); await sleep(10);
  s.shortcuts.get(keys.speakLast).handler(s.ctx); await sleep(15);
  assert.deepEqual(s.texts(), ['Resultado listo.']);
  watchers[0].speak('copiado'); await sleep(15);
  assert.equal(s.children.length, 2, 'copy speech superseded the first and spoke at once');
  assert.equal(JSON.parse(s.children[1].writes[0]).text, 'copiado');
  s.shutdown();
});

test('two sessions sharing one lock dir never overlap playback', async () => {
  const home = sharedHome(); save(home);
  const a = session(home, { text: 'De A.' }), b = session(home, { text: 'De B.' });
  const pa = a.settle(); await sleep(15);
  const pb = b.settle(); await sleep(60);
  assert.equal(a.children.length, 1); assert.equal(b.children.length, 0, 'B waits for the single voice');
  a.finish(a.children[0]); await pa; await sleep(60);
  assert.deepEqual(b.texts(), ['De B.']);
  b.finish(b.children[0]); await pb; await sleep(10);
  assert.equal(lockHeld(home), false);
  a.shutdown(); b.shutdown();
});

test('stop aborts a waiting acquire and never blocks or kills another session', async () => {
  const home = sharedHome(); save(home);
  const a = session(home, { text: 'De A.' }), b = session(home, { text: 'De B.' });
  const pa = a.settle(); await sleep(15);
  const pb = b.tool('De B tool'); await sleep(30);
  b.shortcuts.get(keys.stop).handler(b.ctx);
  const out = await pb;
  assert.equal(out.isError, true); assert.equal(out.content[0].text, 'Speech cancelled.');
  assert.equal(a.children[0].killed, 0, 'B stop does not touch A');
  a.finish(a.children[0]); await pa; await sleep(60);
  assert.equal(b.children.length, 0, 'the aborted waiter never takes the lock');
  assert.equal(lockHeld(home), false);
  a.shutdown(); b.shutdown();
});

test('stop releases a held lock; a new own utterance supersedes the old one and releases it', async () => {
  const home = sharedHome(); save(home);
  const s = session(home);
  const p1 = s.tool('uno'); await sleep(15);
  assert.equal(lockHeld(home), true);
  s.shortcuts.get(keys.stop).handler(s.ctx); await p1;
  assert.equal(s.children[0].killed >= 1, true); assert.equal(lockHeld(home), false);
  const p2 = s.tool('dos'); await sleep(15);
  const p3 = s.tool('tres'); await sleep(15);
  assert.equal(s.children[1].killed >= 1, true); assert.equal((await p2).content[0].text, 'Speech cancelled.');
  assert.equal(JSON.parse(s.children[2].writes[0]).text, 'tres'); assert.equal(lockHeld(home), true);
  s.finish(s.children[2]); await p3; await sleep(10);
  assert.equal(lockHeld(home), false);
  s.shutdown();
});

test('a playback failure releases the lock', async () => {
  const home = sharedHome(); save(home); const s = session(home);
  const p = s.tool('uno'); await sleep(15);
  s.children[0].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'error', id: 1 }) + '\n');
  assert.equal((await p).isError, true); await sleep(10);
  assert.equal(lockHeld(home), false); s.shutdown();
});

test('shutdown disposes the deferral, aborts a waiting acquire, releases the lock and nothing speaks afterwards', async () => {
  const home = sharedHome(); save(home);
  const a = session(home, { text: 'De A.' }), pending = session(home, { text: 'Pendiente.' }), waiter = session(home);
  pending.state.focus = 'unfocused'; await pending.settle();
  const pa = a.settle(); await sleep(15);
  const pw = waiter.tool('espera'); await sleep(30);
  a.shutdown(); pending.shutdown(); waiter.shutdown();
  assert.equal(a.children[0].killed >= 1, true); assert.equal(lockHeld(home), false);
  assert.equal((await pw).isError, true);
  pending.state.focus = 'focused'; await sleep(60);
  assert.equal(pending.children.length, 0); assert.equal(waiter.children.length, 0);
  assert.equal((await waiter.tool('tarde')).isError, true); assert.equal(waiter.children.length, 0);
  await pa;
});

test('toggle off and the stop key clear the pending item', async () => {
  const home = sharedHome(); save(home);
  const s = session(home); s.state.focus = 'unfocused';
  await s.settle();
  s.shortcuts.get(keys.toggle).handler(s.ctx); await sleep(10);
  s.state.focus = 'focused'; await sleep(40);
  assert.equal(s.children.length, 0);
  save(home); s.state.focus = 'unfocused'; await s.settle();
  s.shortcuts.get(keys.stop).handler(s.ctx);
  s.state.focus = 'focused'; await sleep(40);
  assert.equal(s.children.length, 0); s.shutdown();
});

test('default focus check combines Herdr with the terminal-frontmost bundle id; unidentifiable means unknown (prefix)', async () => {
  const cases: Array<[any, 'now' | 'deferred' | 'prefix']> = [
    [{ terminal: 'com.t', front: 'com.t' }, 'now'],
    [{ terminal: 'com.t', front: 'com.other' }, 'deferred'],
    [{ herdr: false, terminal: 'com.t', front: 'com.t' }, 'deferred'],
    [{ terminal: 'com.t', front: undefined }, 'prefix'],
    [{ terminal: undefined, front: 'com.t' }, 'prefix'],
    [{ env: {} , terminal: 'com.t', front: 'com.t' }, 'prefix'],
  ];
  for (const [o, expected] of cases) {
    const home = sharedHome(); save(home);
    const execs: string[][] = [];
    const t = mkReal(home, o, execs);
    const p = t.settle(); await sleep(30);
    if (expected === 'deferred') assert.equal(t.children.length, 0, JSON.stringify(o));
    else assert.deepEqual(t.texts(), [expected === 'now' ? 'Resultado listo.' : 'gentle-theme: Resultado listo.'], JSON.stringify(o));
    if (o.env === undefined) assert.deepEqual(execs[0]?.slice(0, 3), ['herdr', 'pane', 'get']);
    t.shutdown(); await p;
  }
});

function mkReal(home: string, o: any, execs: string[][]) {
  const children: any[] = []; const events = new Map<string, Function>();
  const ctx: any = { cwd: '/work/gentle-theme', mode: 'tui', hasUI: true, isIdle: () => true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => msg('Resultado listo.') }, ui: { setStatus() {}, notify() {}, confirm: async () => false, select: async () => undefined, input: async () => undefined } };
  const spawn = () => { const c: any = Object.assign(new EventEmitter(), { writes: [] as string[], stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }); c.stdin = { write: (l: string) => { c.writes.push(l); return true; } }; children.push(c); return c; };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool() {} } as any, home, {
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn,
    env: o.env ?? { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }, focusPollMs: 1000, lockPollMs: 5,
    herdrExec: async (f: string, a: string[]) => { execs.push([f, ...a]); return JSON.stringify({ result: { pane: { focused: o.herdr ?? true } } }); },
    resolveTerminal: async () => o.terminal, readFrontmost: async () => o.front } as any);
  return { children, settle: () => events.get('agent_settled')!({ aborted: false }, ctx), texts: () => children.filter(c => c.writes.length).map(c => JSON.parse(c.writes[0]).text), shutdown: () => events.get('session_shutdown')!({}, ctx) };
}
