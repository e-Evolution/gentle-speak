import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const clip: any = await import(ROOT + '/lib/speak-clipboard.ts');
const { default: gentleSpeak } = await import(ROOT + '/extensions/gentle-speak.ts');
import { hermetic } from './helpers/hermetic.ts';
const { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } = await import(ROOT + '/lib/speak-settings.ts');
const SENT = 'SENTINEL-s3cr3t-9f2a';
const line = (types: string[], front = 'com.term', n = 2) => ['GSCLIP', n, types.join(','), front].join('\t') + '\n';
const tick = () => new Promise(r => setImmediate(r));
function fakeChild() { const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.killed = 0; c.kill = () => { c.killed++; return true; }; return c; }
const goodTui = (o: any = {}) => ({ getCopyOnSelect: () => true, hasActiveSelection: () => true, getScreenLines: () => ['\x1b[31m' + SENT + '\x1b[0m'], ...o });

test('S8 every concealed/transient type blocks readText', async () => {
  for (const t of clip.SKIPPED_PASTEBOARD_TYPES) {
    assert.equal(clip.SKIPPED_PASTEBOARD_TYPES.length, 6);
    let reads = 0, spoke = 0; const c = fakeChild();
    const w = clip.createCopiedSelectionWatcher({ terminalBundleId: 'com.term', spawn: () => c, readText: async () => { reads++; return SENT; }, speak: () => { spoke++; }, onError: () => {} });
    w.start(); c.stdout.emit('data', line(['public.utf8-plain-text', t]));  await tick();
    assert.equal(reads, 0, t); assert.equal(spoke, 0, t);
  }
});
test('S8 non-terminal frontmost blocks readText; terminal passes', async () => {
  let reads = 0, spoke: string[] = []; const c = fakeChild();
  const w = clip.createCopiedSelectionWatcher({ terminalBundleId: 'com.term', spawn: () => c, readText: async () => { reads++; return SENT; }, speak: (t: string) => { spoke.push(t); }, onError: () => {} });
  w.start(); c.stdout.emit('data', line(['public.utf8-plain-text'], 'com.other')); c.stdout.emit('data', line(['public.utf8-plain-text'], '')); await tick();
  assert.equal(reads, 0);
  c.stdout.emit('data', line(['public.utf8-plain-text'])); await tick(); await tick();
  assert.deepEqual(spoke, [SENT]);
});
test('S8 own-copy gate refusals', () => {
  const g = (t: any) => clip.createOwnCopyGate(() => t);
  assert.equal(g(goodTui())(SENT), true);
  assert.equal(g(goodTui())('  ' + SENT.slice(0,6) + '\n'), true === true ? g(goodTui())(SENT.slice(0,6)) : false);
  for (const [name, tui] of Object.entries({
    undefinedTui: undefined, nullTui: null, plain: { render: () => [] },
    missingCopyOnSelect: { hasActiveSelection: () => true, getScreenLines: () => [SENT] },
    missingHas: { getCopyOnSelect: () => true, getScreenLines: () => [SENT] },
    missingLines: { getCopyOnSelect: () => true, hasActiveSelection: () => true },
    notFn: { getCopyOnSelect: true, hasActiveSelection: () => true, getScreenLines: () => [SENT] },
    copyOnSelectFalse: goodTui({ getCopyOnSelect: () => false }),
    copyOnSelectTruthy: goodTui({ getCopyOnSelect: () => 1 }),
    noSelection: goodTui({ hasActiveSelection: () => false }),
    selectionTruthy: goodTui({ hasActiveSelection: () => 'yes' }),
    notOnScreen: goodTui({ getScreenLines: () => ['other'] }),
    emptyScreen: goodTui({ getScreenLines: () => [] }),
    throwsCopy: goodTui({ getCopyOnSelect: () => { throw new Error('x'); } }),
    throwsSel: goodTui({ hasActiveSelection: () => { throw new Error('x'); } }),
    throwsLines: goodTui({ getScreenLines: () => { throw new Error('x'); } }),
    linesNonArray: goodTui({ getScreenLines: () => null }),
  })) assert.equal(g(tui)(SENT), false, name);
  assert.equal(clip.createOwnCopyGate(() => { throw new Error('boom'); })(SENT), false);
  assert.equal(g(goodTui())('   '), false);
  assert.equal(g(goodTui())(''), false);
});
test('S8 watcher with isOwnCopy refusing: readText ran but speak did not; throwing gate does not speak and errors carry no text', async () => {
  for (const gate of [() => false, () => { throw new Error('gate ' + SENT); }]) {
    let spoke = 0; const errs: string[] = []; const c = fakeChild();
    const w = clip.createCopiedSelectionWatcher({ terminalBundleId: 'com.term', spawn: () => c, readText: async () => SENT, isOwnCopy: gate, speak: () => { spoke++; }, onError: (e: Error) => errs.push(e.message) });
    w.start(); c.stdout.emit('data', line(['public.utf8-plain-text'])); await tick(); await tick();
    assert.equal(spoke, 0); assert.ok(errs.every(e => !e.includes(SENT)), errs.join('|'));
  }
});
test('S8 sentinel never in watcher errors (readText throw, speak throw, crash, exit)', async () => {
  const errs: string[] = [];
  for (const mode of ['read', 'speak', 'crash', 'exit']) {
    const c = fakeChild();
    const w = clip.createCopiedSelectionWatcher({ terminalBundleId: 'com.term', spawn: () => c,
      readText: async () => { if (mode === 'read') throw new Error(SENT); return SENT; },
      speak: () => { if (mode === 'speak') throw new Error(SENT); }, onError: (e: Error) => errs.push(e.message + (e.stack ?? '')) });
    w.start();
    if (mode === 'crash') c.emit('error', new Error(SENT)); else if (mode === 'exit') c.emit('exit', 1, SENT); else c.stdout.emit('data', line(['public.utf8-plain-text']));
    await tick(); await tick();
  }
  assert.ok(errs.length >= 3, String(errs.length)); assert.ok(errs.every(e => !e.includes(SENT)));
});
test('S8 unresolvable terminal: watcher refuses, spawn never called', () => {
  let spawned = 0; const errs: string[] = [];
  const w = clip.createCopiedSelectionWatcher({ terminalBundleId: undefined, spawn: () => { spawned++; return fakeChild(); }, readText: async () => SENT, speak: () => {}, onError: (e: Error) => errs.push(e.message) });
  w.start(); assert.equal(spawned, 0); assert.equal(errs.length, 1);
});
test('WATCH_SCRIPT is read-only and prints only count/types/bundle id', () => {
  const s: string = clip.WATCH_SCRIPT;
  console.log(s);
  for (const bad of ['setString', 'setData', 'setPropertyList', 'clearContents', 'declareTypes', 'writeObjects', 'stringForType', 'dataForType', 'propertyListForType', 'readObjects', 'pasteboardItems', 'writeFile', 'doShellScript', 'NSTask', 'NSData', 'system(']) assert.equal(s.includes(bad), false, bad);
  // One output point only: the stdout emitter (L51), called once, with no console.log.
  assert.equal((s.match(/console\.log/g) ?? []).length, 0);
  assert.equal((s.match(/writeData/g) ?? []).length, 1);
  assert.equal((s.match(/fileHandleWithStandardOutput/g) ?? []).length, 1);
  assert.equal((s.match(/emit\('/g) ?? []).length, 1);
});

// ---- extension level
function ext(over: { mode?: string; header?: any; tui?: any; terminal?: string | undefined; copy?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gs-probe-'));
  const events = new Map<string, Function>(), commands = new Map<string, any>(); const notes: string[] = []; const selections: string[] = [];
  const children: any[] = []; const watcherSpawns: any[] = []; const reads: number[] = []; const speaks: string[] = [];
  const mkCtx = () => ({ mode: over.mode ?? 'tui', hasUI: true, isIdle: () => true, sessionManager: { getHeader: () => over.header ?? { type: 'session' }, getBranch: () => [] }, ui: { setStatus() {}, notify: (t: string) => notes.push(t), confirm: async () => false, select: async () => selections.shift(), input: async () => undefined,
    setWidget: (_k: string, f: any) => { if (typeof f === 'function') f('tui' in over ? over.tui : goodTui(), {}); } } });
  const ctx: any = mkCtx();
  writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, copySpeech: over.copy !== false }));
  const deps = { ...hermetic(home), sayAvailable: () => false, modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), qwenStatus: async () => ({ manifest: 'missing', voices: {} }),
    spawn: () => { const c: any = new EventEmitter(); c.stdin = { write: (l: string) => { speaks.push(l); return true; } }; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => true; children.push(c); return c; },
    resolveTerminal: async () => ('terminal' in over ? over.terminal : 'com.term'),
    createWatcher: (opts: any) => { const wc = fakeChild(); watcherSpawns.push(wc); return clip.createCopiedSelectionWatcher({ ...opts, spawn: () => wc, readText: async () => { reads.push(1); return SENT; } }); } };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut() {}, registerTool() {} } as any, home, deps as any);
  return { home, events, commands, notes, selections, ctx, children, watcherSpawns, reads, speaks, close: () => rmSync(home, { recursive: true, force: true }) };
}
test('S8 extension: never starts unless copySpeech AND interactive parent', async () => {
  const cases: any[] = [ [{ copy: false }, 0], [{ mode: 'rpc' }, 0], [{ mode: 'print' }, 0], [{ mode: 'json' }, 0], [{ header: { type: 'session', parentSession: '/p' } }, 0], [{ header: undefined, mode: 'tui' }, 1] ];
  for (const [o, n] of cases) { const h = ext(o); try { await h.events.get('session_start')!({}, h.ctx); await tick(); assert.equal(h.watcherSpawns.length, n, JSON.stringify(o)); } finally { h.close(); } }
});
test('S8 extension: unresolvable terminal and non-fullscreen do not start; no clipboard text in notes', async () => {
  for (const o of [{ terminal: undefined }, { tui: { render() {} } }, { tui: undefined }]) { const h = ext(o as any); try { await h.events.get('session_start')!({}, h.ctx); await tick(); assert.equal(h.watcherSpawns.length, 0); assert.equal(h.notes.length, 1); } finally { h.close(); } }
});
test('S8 extension: toggle off, shutdown kill the osascript child; wrapper end-to-end gate', async () => {
  const h = ext(); try {
    await h.events.get('session_start')!({}, h.ctx); await tick();
    assert.equal(h.watcherSpawns.length, 1); const wc = h.watcherSpawns[0];
    // end-to-end speak
    wc.stdout.emit('data', line(['public.utf8-plain-text'])); await tick(); await tick(); await tick();
    assert.equal(h.speaks.length, 1, 'own copy spoken');
    // toggle off
    h.selections.push('Toggle speak copied selection'); await h.commands.get('speak').handler('', h.ctx); await tick();
    assert.equal(wc.killed, 1, 'toggle off killed child'); assert.equal(h.watcherSpawns.length, 1);
    h.selections.push('Toggle speak copied selection'); await h.commands.get('speak').handler('', h.ctx); await tick();
    assert.equal(h.watcherSpawns.length, 2); const wc2 = h.watcherSpawns[1];
    h.events.get('session_shutdown')!({ reason: 'reload' }, h.ctx);
    assert.equal(wc2.killed, 1, 'shutdown/reload killed child');
    // late data after shutdown ignored
    const before = h.speaks.length; wc2.stdout.emit('data', line(['public.utf8-plain-text'])); await tick(); await tick(); assert.equal(h.speaks.length, before);
    assert.ok(h.notes.every(n => !n.includes(SENT)));
  } finally { h.close(); }
});
test('S8 extension: not-on-screen / no selection / copyOnSelect false never reach speak, through extension', async () => {
  for (const tui of [goodTui({ getScreenLines: () => ['nope'] }), goodTui({ hasActiveSelection: () => false }), goodTui({ getCopyOnSelect: () => false }), goodTui({ getScreenLines: () => { throw new Error(SENT); } })]) {
    const h = ext({ tui }); try { await h.events.get('session_start')!({}, h.ctx); await tick(); h.watcherSpawns[0].stdout.emit('data', line(['public.utf8-plain-text'])); await tick(); await tick(); await tick(); assert.equal(h.speaks.length, 0); assert.ok(h.notes.every(n => !n.includes(SENT))); } finally { h.close(); }
  }
});
test('S8 extension: sentinel text never in notifications when speech fails, and worker crash/stderr', async () => {
  for (const failure of ['error-msg', 'exit', 'child-error', 'stderr']) {
    const h = ext(); try {
      await h.events.get('session_start')!({}, h.ctx); await tick();
      h.watcherSpawns[0].stdout.emit('data', line(['public.utf8-plain-text'])); await tick(); await tick(); await tick();
      const c = h.children[0]; assert.ok(c, 'child created');
      if (failure === 'error-msg') c.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'error', id: 1, message: SENT, code: SENT }) + '\n');
      if (failure === 'exit') c.emit('exit', 1, SENT);
      if (failure === 'child-error') c.emit('error', new Error(SENT));
      if (failure === 'stderr') { c.stderr.emit('data', SENT); c.emit('exit', 1); }
      await tick(); await tick();
      console.log(failure, JSON.stringify(h.notes));
      assert.ok(h.notes.every(n => !n.includes(SENT)), failure + ': ' + h.notes.join('|'));
    } finally { h.close(); }
  }
});
