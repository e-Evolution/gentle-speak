import './helpers/guard-real-home.ts';
// T42 / S14: custom voices in settings, the shared service, the installer's VoiceDesign download, and every /speak action.
// All fakes: no Python, no model, no network, no audio; scratch lives under mkdtemp.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, parseSpeakSettingsFile, readSpeakSettings } from '../lib/speak-settings.ts';
import { QWEN_DESIGN_MODEL_ID, QWEN_PYTHON_FLAGS, VOICE_CATALOG } from '../lib/speak-voices.ts';
import { describeDesignModelSize, designModelSize, designModelStatus, installDesignModel } from '../lib/speak-voices-install.ts';
import { connectQwenService } from '../lib/speak-qwen-service.ts';
import { createCustomVoice, listCustomVoices } from '../lib/speak-custom-voices.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';
import { qwenFixture, rawClient } from './helpers/qwen-service-fixture.ts';
import { makeWav, sha256, writeEntry } from './helpers/custom-voice-fixture.ts';

const until = async (cond: () => boolean, what = 'condition') => { const end = Date.now() + 5000; while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 2)); } };
const quiet = (ms = 40) => new Promise(r => setTimeout(r, ms));

// ---- settings ----
test('settings accept custom:<id> and reject malformed custom ids; built-in voices and the default are unchanged', () => {
  const parse = (voice: unknown) => parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, voice }));
  assert.equal(parse('custom:mi-voz')?.voice, 'custom:mi-voz');
  assert.equal(parse('custom:a')?.voice, 'custom:a');
  for (const bad of ['custom:', 'custom:Mi', 'custom:-x', 'custom:a_b', `custom:${'a'.repeat(33)}`, 'custom:../x', 'custom:a/b', 'custom', 'unknown']) assert.equal(parse(bad), undefined, String(bad));
  for (const id of Object.keys(VOICE_CATALOG)) assert.equal(parse(id)?.voice, id);
  assert.equal(DEFAULT_SPEAK_SETTINGS.voice, 'es_MX');
});

// ---- shared service: ref validation ----
test('the shared service accepts refs under voices/custom/<id>/reference.wav and rejects everything else, including voices/qwen3/ (T45)', async () => {
  const fx = qwenFixture();
  try {
    const custom = join(fx.home, 'voices', 'custom');
    writeFileSync(join(fx.root, 'outside.wav'), 'RIFF');
    mkdirSync(join(custom, 'mi-voz'), { recursive: true }); writeFileSync(join(custom, 'mi-voz', 'reference.wav'), 'RIFF'); writeFileSync(join(custom, 'mi-voz', 'voice.json'), '{}');
    mkdirSync(join(custom, 'mi-voz', 'sub')); writeFileSync(join(custom, 'mi-voz', 'sub', 'reference.wav'), 'RIFF');
    mkdirSync(join(custom, 'evil')); symlinkSync(join(fx.root, 'outside.wav'), join(custom, 'evil', 'reference.wav'));
    mkdirSync(join(fx.home, 'voices', 'qwen3'), { recursive: true }); writeFileSync(join(fx.home, 'voices', 'qwen3', 'ref.wav'), 'RIFF');
    mkdirSync(join(fx.home, 'voices', 'other')); writeFileSync(join(fx.home, 'voices', 'other', 'reference.wav'), 'RIFF');
    mkdirSync(join(custom, 'Bad_Id')); writeFileSync(join(custom, 'Bad_Id', 'reference.wav'), 'RIFF');
    const connection = await connectQwenService(fx.options()); connection.socket.setEncoding('utf8');
    const c = rawClient(connection.socket, connection.rest);
    const dir = fx.outDir();
    const send = (id: number, ref: string) => c.send({ type: 'synth', id, priority: 'speak', text: 'hola', ref, refText: 'ref', outDir: dir, speed: 1 });
    send(1, join(custom, 'mi-voz', 'reference.wav'));
    await c.waitFor(m => m.some(x => x.id === 1 && x.type === 'done'), 'custom ref accepted');
    const rejected: Array<[number, string]> = [
      [10, join(custom, 'mi-voz', 'voice.json')], [11, join(custom, 'mi-voz', 'sub', 'reference.wav')], [12, join(custom, 'evil', 'reference.wav')],
      [13, join(fx.home, 'voices', 'other', 'reference.wav')], [14, join(custom, 'Bad_Id', 'reference.wav')], [15, `${custom}/mi-voz/../../qwen3/ref.wav`],
      [16, join(custom, 'reference.wav')], [19, join(fx.home, 'voices', 'qwen3', 'ref.wav')], [17, join(fx.home, 'voices', 'custom') + '/'], [18, join(fx.root, 'outside.wav')],
    ];
    for (const [id, ref] of rejected) { send(id, ref); await c.waitFor(m => m.some(x => x.id === id && x.type === 'error'), `rejected ${ref}`); assert.match(c.ofId(id)[0].message, /^invalid request: /, ref); }
    assert.equal(fx.read('order.log').length, 1, 'only the accepted request reached Python');
  } finally { await fx.close(); }
});

// ---- installer: VoiceDesign model ----
test('designModelStatus reports installed only for a complete cached snapshot', async () => {
  const hf = mkdtempSync(join(tmpdir(), 'gs-hf-'));
  try {
    assert.equal(await designModelStatus(hf), 'missing');
    const repo = join(hf, 'hub', 'models--mlx-community--Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16');
    mkdirSync(join(repo, 'snapshots', 'abc', 'speech_tokenizer'), { recursive: true }); mkdirSync(join(repo, 'blobs'));
    writeFileSync(join(repo, 'snapshots', 'abc', 'config.json'), '{}');
    assert.equal(await designModelStatus(hf), 'missing', 'config only');
    symlinkSync(join(repo, 'blobs', 'gone'), join(repo, 'snapshots', 'abc', 'model.safetensors'));
    assert.equal(await designModelStatus(hf), 'missing', 'dangling weights (an interrupted download)');
    rmSync(join(repo, 'snapshots', 'abc', 'model.safetensors')); writeFileSync(join(repo, 'snapshots', 'abc', 'model.safetensors'), 'weights');
    assert.equal(await designModelStatus(hf), 'installed');
    rmSync(join(repo, 'snapshots', 'abc', 'speech_tokenizer'), { recursive: true });
    assert.equal(await designModelStatus(hf), 'missing', 'no speech tokenizer');
  } finally { rmSync(hf, { recursive: true, force: true }); }
});

test('the download size comes from the Hugging Face API when reachable, else an approximate value with its source', async () => {
  let url = '';
  const bytes = await designModelSize((async (u: string) => { url = u; return { ok: true, json: async () => ({ siblings: [{ rfilename: 'a', size: 4_000_000_000 }, { rfilename: 'b', size: 500_000_000 }, { rfilename: 'c' }] }) }; }) as any);
  assert.equal(bytes, 4_500_000_000);
  assert.match(url, /^https:\/\/huggingface\.co\/api\/models\/mlx-community\/Qwen3-TTS-12Hz-1\.7B-VoiceDesign-bf16/);
  assert.equal(await designModelSize((async () => { throw new Error('offline'); }) as any), undefined);
  assert.equal(await designModelSize((async () => ({ ok: false, json: async () => ({}) })) as any), undefined);
  assert.equal(await designModelSize((async () => ({ ok: true, json: async () => ({ siblings: [] }) })) as any), undefined);
  assert.match(describeDesignModelSize(4_500_000_000), /4\.5 GB.*Hugging Face/);
  assert.match(describeDesignModelSize(undefined), /aprox\. 4\.\d GB.*caché local/);
});

test('installDesignModel refuses without confirmation, runs the worker interpreter online, and verifies the result', async () => {
  const hf = mkdtempSync(join(tmpdir(), 'gs-hf-'));
  try {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run = async (command: string, args: string[], o: any) => { calls.push({ command, args, env: o.env }); return { code: 0 }; };
    await assert.rejects(installDesignModel({ python: '/py', hfHome: hf, home: '/home/u', confirmed: false as any, run }), /confirmation/i);
    assert.equal(calls.length, 0);
    await assert.rejects(installDesignModel({ python: '/py', hfHome: hf, home: '/home/u', confirmed: true, run }), /not.*(complete|installed)|verify/i, 'the run exited 0 but nothing is cached');
    assert.deepEqual(calls[0].args.slice(0, 2), [...QWEN_PYTHON_FLAGS]); assert.equal(calls[0].command, '/py');
    assert.match(calls[0].args.join(' '), new RegExp(QWEN_DESIGN_MODEL_ID));
    assert.equal(calls[0].env.HF_HUB_OFFLINE, undefined, 'the download is the one online step');
    assert.equal(calls[0].env.HF_HOME, hf);
    await assert.rejects(installDesignModel({ python: '/py', hfHome: hf, home: '/home/u', confirmed: true, run: async () => ({ code: 1 }) }), /download/i);
  } finally { rmSync(hf, { recursive: true, force: true }); }
});

// ---- extension harness ----
interface Opts { voice?: string; patch?: Record<string, unknown>; say?: boolean; design?: 'installed' | 'missing'; script?: (args: string[], out: string) => { code: number | null; stdout: string }; hang?: boolean; installThrows?: boolean; mode?: string; qwenManifest?: boolean }
function setup(o: Opts = {}) {
  const home = mkdtempSync(join(tmpdir(), 'speak-custom-'));
  mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true });
  if (o.qwenManifest !== false) writeFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ python: '/fake/python3' }));
  const custom = join(home, 'voices', 'custom');
  const save = (patch: Record<string, unknown>) => writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'all', voice: o.voice ?? 'es_MX', ...o.patch, ...patch }));
  save({});
  const events = new Map<string, Function>(), shortcuts = new Map<string, any>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const notes: string[] = [], selections: string[] = [], offered: string[][] = [], confirms: Array<[string, string]> = [], confirmAnswers: boolean[] = [], inputs: Array<string | undefined> = [], inputPrompts: string[] = [];
  const aborted: Array<AbortSignal | undefined> = [];
  const pythons: any[] = [], sayCalls: any[] = [], installs: any[] = [], runs: Array<{ args: string[]; env: any }> = [];
  const fakeChild = () => { const c: any = Object.assign(new EventEmitter(), { writes: [] as any[], stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } }); c.stdin = { write: (l: string) => { c.writes.push(JSON.parse(l)); return true; } }; return c; };
  const ctx: any = { cwd: '/work/gentle-theme', mode: o.mode ?? 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [] },
    ui: { setStatus: () => {}, notify: (t: string) => notes.push(t), confirm: async (title: string, text: string) => { confirms.push([title, text]); return confirmAnswers.shift() ?? false; }, select: async (_t: string, opts: string[]) => { offered.push(opts); return selections.shift(); }, input: async (prompt: string) => { inputPrompts.push(prompt); return inputs.shift(); } } };
  const deps: any = {
    ...hermetic(home), sayAvailable: () => o.say !== false, listMacVoices: async () => [{ name: 'Paulina', locale: 'es_MX' }],
    say: async (req: any) => { sayCalls.push(req); return { ok: true, message: 'Speech completed.' }; },
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }),
    spawn: () => fakeChild(), spawnQwen: () => { const c = fakeChild(); pythons.push(c); return c; },
    focusCheck: async () => 'focused', focusPollMs: 5, lockPollMs: 5, qwenTmpRoot: tmpdir(),
    resolveTerminal: async () => 'com.term', createWatcher: () => ({ start() {}, stop() {} }),
    hfHome: join(home, 'hf'), designStatus: async () => o.design ?? 'installed', designSize: async () => 4_500_000_000,
    installDesign: async (opts: any) => { installs.push(opts); if (o.installThrows) throw new Error('download failed'); },
    pythonRun: async (_py: string, args: string[], opt: any) => {
      runs.push({ args, env: opt.env });
      if (o.hang) return new Promise(resolve => { aborted.push(opt.signal); opt.signal?.addEventListener('abort', () => resolve({ code: null, stdout: '' }), { once: true }); });
      const out = args[args.indexOf('--out') + 1];
      if (o.script) return o.script(args, out);
      mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'reference.wav'), makeWav(5));
      return { code: 0, stdout: JSON.stringify({ ok: true, mode: args[args.indexOf('design') >= 0 ? args.indexOf('design') : args.indexOf('import')], file: 'reference.wav', seconds: 5 }) + '\n' };
    },
  };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut: (k: string, s: any) => shortcuts.set(k, s), registerTool: (t: any) => tools.set(t.name, t) } as any, home, deps);
  const settings = () => readSpeakSettings(home);
  return { aborted, home, custom, events, shortcuts, tools, commands, notes, selections, offered, confirms, confirmAnswers, inputs, inputPrompts, ctx, pythons, sayCalls, installs, runs, save, settings,
    menu: (...picks: string[]) => { selections.push(...picks); return commands.get('speak').handler('', ctx); },
    shutdown: () => events.get('session_shutdown')!({}, ctx), close: () => rmSync(home, { recursive: true, force: true }) };
}
const DESIGN = 'Crear voz propia…', IMPORT = 'Importar mi grabación…', DELETE = 'Borrar voz propia…';
const CONSENT = 'Es mi voz o tengo consentimiento explícito de la persona';
const seedVoice = (s: ReturnType<typeof setup>, id = 'mi-voz', label = 'Mi voz') => writeEntry(s.custom, id, { meta: { label } });

test('the /speak menu lists the three actions, and custom voices appear as Voice entries labelled Propia · <label>; built-ins keep their order', async () => {
  const s = setup(); seedVoice(s); seedVoice(s, 'otra', 'Otra');
  try {
    await s.menu('Cancel');
    const o = s.offered[0];
    for (const entry of [DESIGN, IMPORT, DELETE]) assert.ok(o.includes(entry), entry);
    const voices = o.filter(x => x.startsWith('Voice: '));
    assert.equal(voices.length, 5);
    assert.deepEqual(voices.slice(0, 3).map(x => x.match(/\(([^)]+)\) —/)![1]), Object.keys(VOICE_CATALOG));
    assert.deepEqual(voices.slice(3), ['Voice: Propia · Mi voz (custom:mi-voz) — installed', 'Voice: Propia · Otra (custom:otra) — installed']);
  } finally { s.shutdown(); s.close(); }
});

test('a custom voice can be picked in /speak and persists as custom:<id>; with no custom voices nothing else changes', async () => {
  const s = setup(); seedVoice(s);
  try {
    await s.menu('Voice: Propia · Mi voz (custom:mi-voz) — installed');
    assert.equal(s.settings().voice, 'custom:mi-voz');
  } finally { s.shutdown(); s.close(); }
  const plain = setup();
  try { await plain.menu('Cancel'); assert.equal(plain.offered[0].filter(x => x.startsWith('Voice: ')).length, 3); } finally { plain.shutdown(); plain.close(); }
});

test('cycleVoice reaches custom voices after the built-ins and wraps back', async () => {
  const s = setup({ voice: 'mac' }); seedVoice(s);
  try {
    const cycle = s.shortcuts.get(DEFAULT_SPEAK_SETTINGS.shortcuts.cycleVoice).handler;
    await cycle(s.ctx);
    assert.equal(s.settings().voice, 'custom:mi-voz');
    assert.equal(s.notes.at(-1), 'Voice: Propia · Mi voz');
    await cycle(s.ctx);
    assert.notEqual(s.settings().voice, 'custom:mi-voz');
  } finally { s.shutdown(); s.close(); }
});

test('the Dot voice picker offers custom voices and stores custom:<id> in Dot\'s own settings', async () => {
  const s = setup(); seedVoice(s);
  try {
    const dotAgent = join(s.home, 'dot-agent'); mkdirSync(dotAgent, { recursive: true }); writeFileSync(join(dotAgent, 'settings.json'), JSON.stringify({ packages: [] }));
    await s.menu('Gentle Dot', 'Voz de Dot', 'Voice: Propia · Mi voz (custom:mi-voz) — installed');
    const file = join(s.home, 'dot-home', '.gentle-speak', 'speak-settings.json');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).voice, 'custom:mi-voz');
    assert.ok(s.offered.some(list => list.includes('Voice: Propia · Mi voz (custom:mi-voz) — installed')));
  } finally { s.shutdown(); s.close(); }
});

// ---- speech with a custom voice ----
test('speech with a valid custom voice clones its reference with its transcript through the local worker', async () => {
  const s = setup({ voice: 'custom:mi-voz', say: false }); seedVoice(s);
  try {
    const run = s.tools.get('speak').execute('id', { text: 'Hola mundo.' }, undefined, undefined, s.ctx);
    await until(() => s.pythons.length === 1, 'worker');
    s.pythons[0].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak.qwen/v1', type: 'ready' }) + '\n');
    await until(() => s.pythons[0].writes.length === 1, 'synth');
    const synth = s.pythons[0].writes[0];
    assert.equal(synth.ref, join(s.custom, 'mi-voz', 'reference.wav')); assert.equal(synth.refText, 'Hola, esta es mi voz.'); assert.equal(synth.text, 'Hola mundo.');
    s.shutdown(); await run;
  } finally { s.close(); }
});

for (const [name, breakIt] of [
  ['missing', (s: ReturnType<typeof setup>) => rmSync(join(s.custom, 'mi-voz'), { recursive: true })],
  ['tampered (sha256 mismatch)', (s: ReturnType<typeof setup>) => writeFileSync(join(s.custom, 'mi-voz', 'reference.wav'), makeWav(4, { rate: 16000 }))],
] as const) {
  test(`a selected custom voice that is ${name} falls back to the Mac voice with a notice, like a missing Qwen voice, and never starts a worker`, async () => {
    const s = setup({ voice: 'custom:mi-voz' }); seedVoice(s); breakIt(s);
    try {
      const out = await s.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, s.ctx);
      assert.equal(out.isError, undefined);
      assert.equal(s.sayCalls.length, 1); assert.equal(s.sayCalls[0].text, 'Hola.');
      assert.equal(s.pythons.length, 0);
      assert.equal(s.notes.filter(n => /unavailable \(not installed\); speaking with the Mac voice/.test(n)).length, 1);
    } finally { s.shutdown(); s.close(); }
  });
}

test('without the Mac fallback a missing custom voice is refused with the same kind of error and no worker', async () => {
  const s = setup({ voice: 'custom:mi-voz', patch: { macFallback: false } });
  try {
    const out = await s.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, s.ctx);
    assert.equal(out.isError, true); assert.match(out.content[0].text, /Custom voice "mi-voz" is not installed or is invalid/);
    assert.equal(s.pythons.length, 0); assert.equal(s.sayCalls.length, 0);
    assert.deepEqual(s.notes.filter(n => /not installed or is invalid/.test(n)).length, 1);
  } finally { s.shutdown(); s.close(); }
});

// ---- Crear voz propia… ----
const designInputs = ['Voz cálida, adulta y cercana, con acento mexicano', 'Mi voz', 'Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad.'];

test('Crear voz propia…: model present → asks description, label and sample, shows the privacy note, designs in the background and reports «Voz creada: <label>»', async () => {
  const s = setup(); s.inputs.push(...designInputs);
  try {
    await s.menu(DESIGN);
    await until(() => s.notes.includes('Voz creada: Mi voz'), 'voice created');
    assert.equal(s.installs.length, 0); assert.equal(s.confirms.length, 0, 'no download question when the model is cached');
    assert.equal(s.inputPrompts.length, 3);
    assert.ok(s.notes.some(n => /privacidad|solo con texto|local/i.test(n)), 'privacy note');
    assert.ok(s.notes.filter(n => /Diseñando|diseñ/i.test(n)).length >= 1, 'progress notice');
    const args = s.runs[0].args;
    assert.deepEqual(args.slice(0, 2), [...QWEN_PYTHON_FLAGS]); assert.equal(args[3], 'design');
    assert.equal(args[args.indexOf('--description') + 1], designInputs[0]); assert.equal(args[args.indexOf('--sample') + 1], designInputs[2]); assert.equal(args[args.indexOf('--language') + 1], 'es');
    const { voices } = await listCustomVoices(s.home);
    assert.deepEqual(voices.map(v => [v.id, v.label, v.source, v.transcript]), [['custom:mi-voz', 'Propia · Mi voz', 'designed', designInputs[2]]]);
    assert.equal(JSON.parse(readFileSync(join(s.custom, 'mi-voz', 'voice.json'), 'utf8')).description, designInputs[0]);
    assert.equal(s.settings().voice, 'es_MX', 'creating does not switch the voice');
    assert.deepEqual(readdirSync(s.custom), ['mi-voz']);
  } finally { s.shutdown(); s.close(); }
});

test('Crear voz propia…: an empty sample falls back to a Spanish default sentence', async () => {
  const s = setup(); s.inputs.push(designInputs[0], 'Otra', '');
  try {
    await s.menu(DESIGN);
    await until(() => s.notes.includes('Voz creada: Otra'));
    assert.match(s.runs[0].args[s.runs[0].args.indexOf('--sample') + 1], /^Encontré el problema\./);
  } finally { s.shutdown(); s.close(); }
});

test('Crear voz propia…: model missing → confirmation shows the size; refusing downloads nothing, asks nothing else and runs nothing', async () => {
  const s = setup({ design: 'missing' }); s.confirmAnswers.push(false); s.inputs.push(...designInputs);
  try {
    await s.menu(DESIGN); await quiet();
    assert.equal(s.confirms.length, 1); assert.match(s.confirms[0][1], /4\.5 GB/); assert.match(s.confirms[0][1], new RegExp(QWEN_DESIGN_MODEL_ID));
    assert.equal(s.installs.length, 0); assert.equal(s.runs.length, 0); assert.equal(s.inputPrompts.length, 0);
    assert.equal(existsSync(s.custom), false);
  } finally { s.shutdown(); s.close(); }
});

test('Crear voz propia…: model missing → accepting downloads once with confirmed:true using the worker interpreter, then designs', async () => {
  const s = setup({ design: 'missing' }); s.confirmAnswers.push(true); s.inputs.push(...designInputs);
  try {
    await s.menu(DESIGN);
    await until(() => s.notes.includes('Voz creada: Mi voz'));
    assert.equal(s.installs.length, 1); assert.equal(s.installs[0].confirmed, true); assert.equal(s.installs[0].python, '/fake/python3'); assert.equal(s.confirms.length, 1);
    assert.ok(s.notes.some(n => /Descargando/i.test(n)));
  } finally { s.shutdown(); s.close(); }
});

test('Crear voz propia…: a failed download or a missing Qwen install stops with a notice and creates nothing', async () => {
  const s = setup({ design: 'missing', installThrows: true }); s.confirmAnswers.push(true); s.inputs.push(...designInputs);
  try {
    await s.menu(DESIGN); await quiet();
    assert.equal(s.installs.length, 1); assert.ok(s.notes.some(n => /No pude descargar/.test(n))); assert.equal(s.runs.length, 0); assert.equal(s.inputPrompts.length, 0);
  } finally { s.shutdown(); s.close(); }
  const t = setup({ design: 'missing', qwenManifest: false }); t.confirmAnswers.push(true); t.inputs.push(...designInputs);
  try {
    await t.menu(DESIGN); await quiet();
    assert.ok(t.notes.some(n => /Qwen/.test(n)), 'tells the human to install the Qwen voices first');
    assert.equal(t.installs.length, 0); assert.equal(t.runs.length, 0); assert.equal(t.confirms.length, 0);
  } finally { t.shutdown(); t.close(); }
});

test('Crear voz propia…: cancelled inputs, a script failure and a duplicate label leave no voice and report the problem', async () => {
  let s = setup(); s.inputs.push(undefined);
  try { await s.menu(DESIGN); await quiet(); assert.equal(s.runs.length, 0); assert.equal(existsSync(s.custom), false); } finally { s.shutdown(); s.close(); }
  s = setup({ script: () => ({ code: 2, stdout: '{"ok": false, "code": "design_failed", "message": "The VoiceDesign model could not run"}\n' }) }); s.inputs.push(...designInputs);
  try { await s.menu(DESIGN); await until(() => s.notes.some(n => /No pude crear la voz/.test(n))); assert.equal(existsSync(s.custom) ? readdirSync(s.custom).length : 0, 0); assert.equal(s.notes.includes('Voz creada: Mi voz'), false); } finally { s.shutdown(); s.close(); }
  s = setup(); seedVoice(s); s.inputs.push(...designInputs);
  try { await s.menu(DESIGN); await until(() => s.notes.includes('Voz creada: Mi voz')); assert.deepEqual(readdirSync(s.custom).sort(), ['mi-voz', 'mi-voz-2']); } finally { s.shutdown(); s.close(); }
  s = setup(); s.inputs.push('corta', 'Mi voz', 'x');
  try { await s.menu(DESIGN); await quiet(); assert.equal(s.runs.length, 0, 'invalid description is refused before any process starts'); assert.ok(s.notes.some(n => /descripci/i.test(n))); } finally { s.shutdown(); s.close(); }
});

test('Crear voz propia…: shutdown while designing aborts the job and creates nothing', async () => {
  const s = setup({ hang: true }); s.inputs.push(...designInputs);
  try {
    await s.menu(DESIGN); await until(() => s.runs.length === 1, 'script started');
    s.shutdown(); await quiet();
    assert.equal(s.aborted[0]?.aborted, true);
    assert.equal(s.notes.some(n => /Voz creada/.test(n)), false); assert.equal(existsSync(s.custom) ? readdirSync(s.custom).length : 0, 0);
  } finally { s.close(); }
});

test('the actions are terminal TUI parent only', async () => {
  const s = setup({ mode: 'rpc' });
  try { await s.menu(DESIGN); await quiet(); assert.equal(s.offered.length, 0); assert.equal(s.runs.length, 0); } finally { s.shutdown(); s.close(); }
});

// ---- Importar mi grabación… ----
test('Importar mi grabación…: consent refused → nothing is asked, run or stored', async () => {
  const s = setup(); s.confirmAnswers.push(false); s.inputs.push('/tmp/x.wav', 'Hola', 'Mi voz');
  try {
    await s.menu(IMPORT); await quiet();
    assert.equal(s.confirms.length, 1); assert.match(s.confirms[0][1], new RegExp(CONSENT));
    assert.equal(s.runs.length, 0); assert.equal(s.inputPrompts.length, 0); assert.equal(existsSync(s.custom), false);
  } finally { s.shutdown(); s.close(); }
});

test('Importar mi grabación…: consent given → path, exact transcript and label go to the import script and the voice is stored as recorded', async () => {
  const s = setup(); s.confirmAnswers.push(true);
  const wav = join(s.home, 'mine.wav'); writeFileSync(wav, makeWav(4));
  s.inputs.push(wav, 'Hola, esta es mi voz de verdad.', 'Mi grabación');
  try {
    await s.menu(IMPORT);
    await until(() => s.notes.includes('Voz importada: Mi grabación'), 'imported');
    const args = s.runs[0].args;
    assert.equal(args[3], 'import'); assert.equal(args[args.indexOf('--wav') + 1], wav); assert.equal(args[args.indexOf('--transcript') + 1], 'Hola, esta es mi voz de verdad.');
    const { voices } = await listCustomVoices(s.home);
    assert.deepEqual(voices.map(v => [v.id, v.source, v.transcript]), [['custom:mi-grabacion', 'recorded', 'Hola, esta es mi voz de verdad.']]);
    assert.ok(!s.notes.some(n => n.includes(wav)), 'the input path is never echoed in notices');
  } finally { s.shutdown(); s.close(); }
});

test('Importar mi grabación…: a script rejection (too short, not a WAV…) is reported and stores nothing', async () => {
  const s = setup({ script: () => ({ code: 2, stdout: '{"ok": false, "code": "too_short", "message": "The audio is too short (minimum 3 s)"}\n' }) }); s.confirmAnswers.push(true);
  s.inputs.push('/tmp/none.wav', 'Hola', 'Mi voz');
  try {
    await s.menu(IMPORT);
    await until(() => s.notes.some(n => /No pude importar/.test(n) && /3 s/.test(n)));
    assert.equal(existsSync(s.custom) ? readdirSync(s.custom).length : 0, 0);
  } finally { s.shutdown(); s.close(); }
});

// ---- Borrar voz propia… ----
test('Borrar voz propia…: lists the custom voices, refusing the confirmation deletes nothing', async () => {
  const s = setup(); seedVoice(s); seedVoice(s, 'otra', 'Otra'); s.confirmAnswers.push(false);
  try {
    await s.menu(DELETE, 'Propia · Mi voz (custom:mi-voz)');
    assert.deepEqual(s.offered[1].slice(0, 2), ['Propia · Mi voz (custom:mi-voz)', 'Propia · Otra (custom:otra)']);
    assert.equal(s.confirms.length, 1); assert.deepEqual(readdirSync(s.custom).sort(), ['mi-voz', 'otra']);
  } finally { s.shutdown(); s.close(); }
});

test('Borrar voz propia…: confirming deletes it; deleting the selected voice falls back to the default voice', async () => {
  const s = setup({ voice: 'custom:mi-voz' }); seedVoice(s); seedVoice(s, 'otra', 'Otra'); s.confirmAnswers.push(true, true);
  try {
    await s.menu(DELETE, 'Propia · Otra (custom:otra)');
    assert.deepEqual(readdirSync(s.custom), ['mi-voz']); assert.equal(s.settings().voice, 'custom:mi-voz', 'another voice deleted: selection kept');
    await s.menu(DELETE, 'Propia · Mi voz (custom:mi-voz)');
    assert.deepEqual(readdirSync(s.custom), []); assert.equal(s.settings().voice, 'es_MX');
    assert.ok(s.notes.some(n => /Voz borrada: Mi voz/.test(n)));
  } finally { s.shutdown(); s.close(); }
});

test('Borrar voz propia… with no custom voices only says so', async () => {
  const s = setup();
  try { await s.menu(DELETE); assert.ok(s.notes.some(n => /No hay voces propias/.test(n))); assert.equal(s.confirms.length, 0); } finally { s.shutdown(); s.close(); }
});

// ---- preserve ----
test('PRESERVE: Qwen speech through a custom voice uses its reference.wav and transcript', async () => {
  const s = setup({ voice: 'custom:mi-voz', say: false }); seedVoice(s);
  try {
    const run = s.tools.get('speak').execute('id', { text: 'Hola.' }, undefined, undefined, s.ctx);
    await until(() => s.pythons.length === 1);
    s.pythons[0].stdout.emit('data', JSON.stringify({ schema: 'gentle.speak.qwen/v1', type: 'ready' }) + '\n');
    await until(() => s.pythons[0].writes.length === 1);
    assert.equal(s.pythons[0].writes[0].ref, join(s.home, 'voices', 'custom', 'mi-voz', 'reference.wav'));
    assert.equal(s.pythons[0].writes[0].refText, 'Hola, esta es mi voz.');
    s.shutdown(); await run;
  } finally { s.close(); }
});
