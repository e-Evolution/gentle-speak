import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';

// S10 wiring: message_update drives speculative synthesis, agent_settled plays the prepared WAVs. All fakes; no model, no audio.
const QS = 'gentle.speak.qwen/v1', AS = 'gentle.speak/v1';
const until = async (predicate: () => boolean, what = 'condition') => { for (let i = 0; i < 400 && !predicate(); i++) await new Promise(r => setImmediate(r)); assert.ok(predicate(), `not reached: ${what}`); };
const quiet = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
function fakeChild() {
  const writes: any[] = [];
  const child: any = Object.assign(new EventEmitter(), { stdin: { write: (line: string) => { writes.push(JSON.parse(line)); return true; } }, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0, kill() { child.killed++; return true; } });
  return { child, writes, emit: (m: object) => child.stdout.emit('data', JSON.stringify(m) + '\n') };
}
const installed = (ids: string[]) => ({ manifest: 'valid', voices: Object.fromEntries(['qwen-intima', 'qwen-brisa'].map(id => [id, ids.includes(id) ? 'installed' : 'missing'])) });
const text = (value: string) => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: value }] });

function setup(opts: { voice?: string; mode?: string; ctxMode?: string; header?: unknown; focus?: () => string; enabled?: boolean; settleText?: string; dot?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'speak-spec-'));
  const events = new Map<string, Function>(), shortcuts = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const pythons: Array<ReturnType<typeof fakeChild>> = [], audios: Array<ReturnType<typeof fakeChild>> = [];
  const notes: string[] = [];
  let branch: any[] = [{ type: 'message', message: text('x') }];
  const state = { focus: 'focused' };
  const scratch = join(home, 'scratch'); mkdirSync(scratch); // keeps prepared WAVs out of the shared system temp dir other tests inspect
  mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true });
  writeFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ python: '/fake/python3' }));
  const save = (patch: Record<string, unknown>) => writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, ...(opts.dot ? { dotSpeech: true } : {}), enabled: opts.enabled ?? true, mode: opts.mode ?? 'all', voice: opts.voice ?? 'qwen-intima', ...patch }));
  save({});
  const selections: string[] = [];
  const ctx: any = { cwd: '/work/gentle-theme', mode: opts.ctxMode ?? 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => opts.header ?? { type: 'session' }, getBranch: () => branch },
    ui: { setStatus() {}, notify: (t: string) => notes.push(t), confirm: async () => false, select: async () => selections.shift(), input: async () => undefined } };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut: (k: string, s: any) => shortcuts.set(k, s), registerTool: (t: any) => tools.set(t.name, t) } as any, home, {
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }),
    qwenStatus: async () => installed(['qwen-intima', 'qwen-brisa']),
    spawn: () => { const a = fakeChild(); audios.push(a); return a.child; },
    spawnQwen: () => { const p = fakeChild(); pythons.push(p); return p.child; },
    focusCheck: async () => (opts.focus ? opts.focus() : state.focus) as any, focusPollMs: 5, lockPollMs: 5, sayAvailable: () => false, qwenTmpRoot: scratch,
    ...hermetic(home),
    ...(opts.dot ? { env: { PI_CODING_AGENT_DIR: join(home, 'dot-agent'), GENTLE_DOT_AGENT_HOME: join(home, 'dot-agent') }, userHome: home } : {}),
  } as any);
  const synths = () => pythons.flatMap((p, index) => p.writes.filter(w => w.type === 'synth').map(w => ({ ...w, python: index })));
  const synthTexts = () => synths().map(w => w.text as string);
  const stream = (value: string, extra: object = {}) => events.get('message_update')!({ message: { ...text(value), stopReason: undefined, ...extra } }, ctx);
  /** Answers synth #n (1-based, in request order) with one chunk file and `done`. */
  const answer = async (n: number) => {
    await until(() => synths().length >= n, `synth #${n}`);
    const w = synths()[n - 1], py = pythons[w.python];
    if (!py.writes.some(m => m.type === 'synth' && m.id === w.id && (m as any).sent)) { /* ready is sent once per worker */ }
    const wav = join(w.outDir, `chunk-${w.id}-0.wav`);
    writeFileSync(wav, 'RIFF');
    py.emit({ schema: QS, type: 'chunk', id: w.id, seq: 0, wav, seconds: 1 });
    py.emit({ schema: QS, type: 'done', id: w.id });
    return wav;
  };
  /** Emits part `seq` of synth #n (1-based) without finishing it. */
  const part = (n: number, seq: number) => {
    const w = synths()[n - 1], py = pythons[w.python];
    const wav = join(w.outDir, `chunk-${w.id}-${seq}.wav`);
    try { writeFileSync(wav, 'RIFF'); } catch { /* the directory was deleted: late traffic of a cancelled prepare */ }
    py.emit({ schema: QS, type: 'chunk', id: w.id, seq, wav, seconds: 1 });
    return wav;
  };
  const finish = (n: number) => { const w = synths()[n - 1]; pythons[w.python].emit({ schema: QS, type: 'done', id: w.id }); };
  const ready = async () => { await until(() => pythons.length === 1, 'python spawned'); pythons[0].emit({ schema: QS, type: 'ready' }); };
  const settle = (final?: string) => { branch = [{ type: 'message', message: text(final ?? opts.settleText ?? 'x') }]; return events.get('agent_settled')!({ aborted: false }, ctx); };
  const plays = () => audios.flatMap(a => a.writes.filter(w => w.type === 'play'));
  return { home, events, shortcuts, tools, commands, ctx, notes, state, pythons, audios, synths, synthTexts, stream, answer, part, finish, ready, settle, plays, save, selections, setBranch: (b: any[]) => { branch = b; },
    close: () => { events.get('session_shutdown')?.({}, ctx); rmSync(home, { recursive: true, force: true }); } };
}
type H = ReturnType<typeof setup>;
const FIRST = 'Primera frase.', SECOND = 'Segunda frase.', THIRD = 'Tercera frase.';
const full = `${FIRST} ${SECOND} ${THIRD}`;
/** Streams two completed sentences and finishes both syntheses; returns their WAVs. */
async function speculated(h: H) {
  await h.stream(`${FIRST} ${SECOND} Terc`);
  await h.ready();
  const a = await h.answer(1);
  const b = await h.answer(2);
  await until(() => existsSync(a) && existsSync(b), 'wavs');
  await quiet();
  return [a, b];
}

test('message_update synthesizes completed sentences only, one at a time, without playing', async () => {
  const h = setup();
  try {
    await h.stream('Primera frase. Segunda fra');
    await h.ready();
    await until(() => h.synths().length === 1, 'first synth');
    assert.deepEqual(h.synthTexts(), [FIRST]);
    await h.answer(1); await quiet();
    assert.deepEqual(h.synthTexts(), [FIRST], 'the incomplete sentence is not synthesized');
    await h.stream(`${FIRST} ${SECOND} Terc`);
    await until(() => h.synths().length === 2, 'second synth');
    assert.deepEqual(h.synthTexts(), [FIRST, SECOND]);
    assert.equal(h.audios.length, 0, 'nothing plays before the answer is final');
  } finally { h.close(); }
});

test('settle plays the prepared WAVs through speakPrepared and synthesizes only the remainder', async () => {
  const h = setup();
  try {
    const [a, b] = await speculated(h);
    const done = h.settle(full);
    await until(() => h.plays().length === 2 && h.synths().length === 3, 'prepared plays + remainder synth');
    assert.deepEqual(h.plays().map(p => p.wav), [a, b]);
    assert.deepEqual(h.synthTexts(), [FIRST, SECOND, THIRD], 'only the remainder is synthesized at settle');
    const c = await h.answer(3);
    await until(() => h.plays().length === 3, 'remainder plays');
    assert.equal(h.plays()[2].wav, c);
    for (const p of h.plays()) h.audios[0].emit({ schema: AS, type: 'done', id: p.id });
    await done; await until(() => ![a, b, c].some(existsSync), 'wavs deleted once played');
  } finally { h.close(); }
});

test('a tool-call turn cancels the speculation and deletes its WAVs (content, toolUse and message_end)', async () => {
  for (const kind of ['content', 'stopReason', 'end'] as const) {
    const h = setup();
    try {
      const wavs = await speculated(h);
      if (kind === 'content') await h.stream(`${FIRST} ${SECOND} Terc`, { content: [{ type: 'text', text: `${FIRST} ${SECOND} Terc` }, { type: 'toolCall', name: 'bash' }] });
      else if (kind === 'stopReason') await h.stream(`${FIRST} ${SECOND}`, { stopReason: 'toolUse' });
      else h.events.get('message_end')!({ message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: FIRST }, { type: 'toolCall' }] } }, h.ctx);
      await until(() => !wavs.some(existsSync), `${kind}: wavs deleted`);
      const done = h.settle(''); await done;
      assert.equal(h.audios.length, 0);
    } finally { h.close(); }
  }
});

test('abort and error cancel and delete; an aborted settle never plays', async () => {
  const h = setup();
  try {
    const wavs = await speculated(h);
    h.events.get('message_end')!({ message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: FIRST }] } }, h.ctx);
    await until(() => !wavs.some(existsSync), 'error: deleted');
  } finally { h.close(); }
  const g = setup();
  try {
    const wavs = await speculated(g);
    await g.events.get('agent_settled')!({ aborted: true }, g.ctx);
    await until(() => !wavs.some(existsSync), 'abort: deleted');
    assert.equal(g.audios.length, 0);
  } finally { g.close(); }
});

test('a final text that does not match discards the WAVs and speaks the whole text normally', async () => {
  const h = setup();
  try {
    const wavs = await speculated(h);
    const other = 'Otra cosa distinta.';
    const done = h.settle(other);
    await until(() => h.synths().length === 3, 'full synth');
    assert.equal(h.synthTexts()[2], other);
    assert.equal(wavs.some(existsSync), false, 'mismatch deletes the prepared audio');
    assert.equal(h.plays().length, 0);
    void done;
  } finally { h.close(); }
});

test('S1 deciding nothing is spoken discards everything', async () => {
  const h = setup({ mode: 'questions-and-results' });
  try {
    await h.stream('Estoy pensando. Voy a mirar. Terc');
    await h.ready();
    const wav = await h.answer(1); await quiet();
    assert.equal(existsSync(wav), true);
    const before = h.synths().length;
    await h.settle('Estoy pensando. Voy a mirar.');
    assert.equal(existsSync(wav), false);
    assert.equal(h.audios.length, 0);
    await quiet();
    assert.equal(h.synths().length, before, 'no further synthesis');
  } finally { h.close(); }
});

test('Piper voices, summary mode, disabled speech and non-parent sessions never speculate', async () => {
  const cases: Array<[string, Parameters<typeof setup>[0]]> = [
    ['piper', { voice: 'es_MX' }], ['summary', { mode: 'summary' }], ['disabled', { enabled: false }],
    ['rpc', { ctxMode: 'rpc' }], ['print', { ctxMode: 'print' }], ['json', { ctxMode: 'json' }], ['child', { header: { type: 'session', parentSession: '/p.jsonl' } }],
  ];
  for (const [name, opts] of cases) {
    const h = setup(opts);
    try {
      await h.stream(`${FIRST} ${SECOND} Terc`);
      await quiet();
      assert.equal(h.pythons.length, 0, `${name}: no synth worker`);
      assert.equal(h.synths().length, 0, name);
    } finally { h.close(); }
  }
});

test('unfocused: the deferred item keeps its prepared audio; a newer item replaces it and the old audio is deleted', async () => {
  const h = setup();
  try {
    h.state.focus = 'unfocused';
    const [a, b] = await speculated(h);
    await h.settle(full);
    await quiet();
    assert.equal([a, b].every(existsSync), true, 'prepared audio survives while deferred');
    assert.equal(h.audios.length, 0);
    // Newer answer: its own speculation, then the settle replaces the pending item.
    await h.stream('Nueva respuesta. Otra.');
    await h.answer(3);
    await h.settle('Nueva respuesta. Otra.');
    await until(() => ![a, b].some(existsSync), 'replaced item audio deleted');
    h.state.focus = 'focused';
    await until(() => h.plays().length >= 1 || h.synths().length >= 4, 'latest item speaks on focus');
    assert.equal(h.plays().some(p => [a, b].includes(p.wav)), false);
  } finally { h.close(); }
});

test('an unfocused deferral plays its prepared audio when focus arrives', async () => {
  const h = setup();
  try {
    h.state.focus = 'unfocused';
    const [a, b] = await speculated(h);
    await h.settle(full); await quiet();
    h.state.focus = 'focused';
    await until(() => h.plays().length === 2, 'prepared audio plays on focus');
    assert.deepEqual(h.plays().map(p => p.wav), [a, b]);
  } finally { h.close(); }
});

test('focus unknown with the project prefix discards prepared audio and speaks the prefixed text normally', async () => {
  const h = setup();
  try {
    h.state.focus = 'unknown';
    const wavs = await speculated(h);
    void h.settle(full);
    await until(() => h.synths().length === 3, 'prefixed synth');
    assert.equal(h.synthTexts()[2], `gentle-theme: ${full}`);
    assert.equal(wavs.some(existsSync), false);
    assert.equal(h.plays().length, 0);
  } finally { h.close(); }
});

test('toggle off, the stop key, a voice change and shutdown delete the speculated files', async () => {
  const toggle = setup();
  try {
    const wavs = await speculated(toggle);
    toggle.save({ enabled: true });
    await toggle.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.toggle).handler(toggle.ctx);
    await until(() => !wavs.some(existsSync), 'toggle off');
  } finally { toggle.close(); }
  const stopKey = setup();
  try {
    const wavs = await speculated(stopKey);
    await stopKey.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.stop).handler(stopKey.ctx);
    await until(() => !wavs.some(existsSync), 'stop key');
  } finally { stopKey.close(); }
  const voice = setup();
  try {
    const wavs = await speculated(voice);
    await voice.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.cycleVoice).handler(voice.ctx);
    await until(() => !wavs.some(existsSync), 'voice change');
  } finally { voice.close(); }
  const down = setup();
  try {
    const wavs = await speculated(down);
    down.events.get('session_shutdown')!({}, down.ctx);
    await until(() => !wavs.some(existsSync), 'shutdown');
    await down.stream(`${FIRST} ${SECOND} Terc`); await quiet();
    assert.equal(down.synths().length, 2, 'no speculation after shutdown');
  } finally { down.close(); }
});

test('a new stream after a settle starts a fresh speculation', async () => {
  const h = setup();
  try {
    await speculated(h);
    const done = h.settle(full);
    await until(() => h.synths().length === 3, 'remainder synth');
    await h.answer(3); await until(() => h.plays().length === 3, 'played');
    for (const p of h.plays()) h.audios[0].emit({ schema: AS, type: 'done', id: p.id });
    await done;
    await h.stream('Nueva uno. Nueva dos. Terc');
    await until(() => h.synths().length === 4, 'fresh synth');
    assert.equal(h.synthTexts()[3], 'Nueva uno.');
  } finally { h.close(); }
});

test('preserve: without streaming, settle speaks the full text through the normal synth; speak-last and the tool never speculate', async () => {
  const h = setup();
  try {
    const done = h.settle(full);
    await h.ready();
    await until(() => h.synths().length === 1, 'normal synth');
    assert.equal(h.synthTexts()[0], full);
    await h.answer(1); await until(() => h.plays().length === 1, 'plays');
    h.audios[0].emit({ schema: AS, type: 'done', id: h.plays()[0].id }); await done;
    h.setBranch([{ type: 'message', message: text('Ultima respuesta.') }]);
    const last = h.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.speakLast).handler(h.ctx);
    await until(() => h.synths().length === 2, 'speak-last synth');
    assert.equal(h.synthTexts()[1], 'Ultima respuesta.');
    void last;
  } finally { h.close(); }
});

// ---- T30b perf fix: settle never aborts a still-useful in-flight prepare; its parts stream into playback ----
test('settle keeps a matching in-flight prepare: its first part plays before the prepare finishes, order stays strict', async () => {
  const h = setup();
  try {
    await h.stream(`${FIRST} ${SECOND} Terc`);
    await h.ready();
    const a = await h.answer(1);
    await until(() => h.synths().length === 2, 'second synth in flight');
    const p0 = h.part(2, 0);
    await quiet();
    const done = h.settle(full);
    await until(() => h.plays().length >= 2, 'in-flight first part plays before its prepare finished');
    assert.deepEqual(h.plays().map(p => p.wav), [a, p0]);
    assert.equal(existsSync(p0), true, 'the in-flight audio was not deleted');
    const p1 = h.part(2, 1);
    await until(() => h.plays().length === 3, 'later part plays as it arrives');
    assert.deepEqual(h.plays().map(p => p.wav), [a, p0, p1]);
    await quiet();
    assert.equal(h.synths().length, 2, 'the remainder waits for the in-flight synthesis (one request at a time)');
    h.finish(2);
    await until(() => h.synths().length === 3, 'remainder synth after the in-flight one');
    assert.equal(h.synthTexts()[2], THIRD);
    const c = await h.answer(3);
    await until(() => h.plays().length === 4, 'remainder plays');
    assert.equal(h.plays()[3].wav, c);
    for (const p of h.plays()) h.audios[0].emit({ schema: AS, type: 'done', id: p.id });
    await done;
    await until(() => ![a, p0, p1, c].some(existsSync), 'every file deleted once played');
  } finally { h.close(); }
});

test('settle aborts and deletes an in-flight prepare that does not match the final text', async () => {
  const h = setup();
  try {
    await h.stream(`${FIRST} ${SECOND} Terc`);
    await h.ready();
    const a = await h.answer(1);
    await until(() => h.synths().length === 2, 'second synth in flight');
    const p0 = h.part(2, 0);
    await quiet();
    const done = h.settle(`${FIRST} Otra cosa.`);
    await until(() => h.synths().length === 3, 'remainder synth');
    assert.equal(h.synthTexts()[2], 'Otra cosa.');
    assert.equal(existsSync(p0), false, 'the mismatching in-flight audio is deleted');
    h.part(2, 1); // late traffic of the aborted prepare is ignored
    const c = await h.answer(3);
    await until(() => h.plays().length === 2, 'matched sentence then remainder');
    assert.deepEqual(h.plays().map(p => p.wav), [a, c]);
    void done;
  } finally { h.close(); }
});

test('an in-flight prepare adopted at settle is aborted and deleted when the deferred item is dropped', async () => {
  const h = setup();
  try {
    h.state.focus = 'unfocused';
    await h.stream(`${FIRST} ${SECOND} Terc`);
    await h.ready();
    await h.answer(1);
    await until(() => h.synths().length === 2, 'second synth in flight');
    const p0 = h.part(2, 0);
    await h.settle(full); await quiet();
    assert.equal(existsSync(p0), true, 'kept while the item is deferred');
    await h.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.stop).handler(h.ctx);
    await until(() => !existsSync(p0), 'dropped item deletes the in-flight audio');
    h.part(2, 1); h.finish(2); await quiet();
    assert.equal(h.audios.length, 0);
  } finally { h.close(); }
});

test('S12: Dot\'s root RPC session speculates and plays with the `Dot: ` prefix, so prepared audio still matches at settle', async () => {
  const h = setup({ ctxMode: 'rpc', dot: true });
  try {
    await h.stream(`${FIRST} ${SECOND} Terc`);
    await h.ready();
    assert.deepEqual(h.synthTexts().slice(0, 1), [`Dot: ${FIRST}`]);
    const a = await h.answer(1);
    await until(() => existsSync(a), 'wav'); await quiet();
    const done = h.settle(`${FIRST} ${SECOND}`);
    await until(() => h.plays().length >= 1, 'prepared audio plays at settle');
    assert.equal(h.plays()[0].wav, a);
    assert.equal(h.synthTexts().includes(`Dot: ${FIRST}`), true);
    void done;
  } finally { h.close(); }
});
