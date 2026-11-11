import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, parseSpeakSettingsFile } from '../lib/speak-settings.ts';
import { settingsHome, sharedHome } from '../lib/speak-home.ts';
import { dotHome } from '../lib/speak-dot.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';

// T34 (S12, L67): Dot keeps its own speak settings under its HOME; assets and the voice lock stay in the real home. Temp homes, fakes, no audio.
const until = async (cond: () => boolean, what = 'condition') => {
  const deadline = Date.now() + 5000;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 1)); }
};
const quiet = (ms = 30) => new Promise(r => setTimeout(r, ms));
const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const file = (settings: Record<string, unknown>) => JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, ...settings });

test('homes: in a terminal both resolve to the same directory', () => {
  const io = { userInfo: () => ({ homedir: '/real' }), homedir: () => '/real' };
  assert.equal(settingsHome(io), '/real/.gentle-speak'); assert.equal(sharedHome(io), '/real/.gentle-speak');
});
test('homes: with $HOME overridden (Dot) the settings follow $HOME and the shared home stays the real one', () => {
  const io = { userInfo: () => ({ homedir: '/real' }), homedir: () => '/real/.gentle-dot/home' };
  assert.equal(settingsHome(io), '/real/.gentle-dot/home/.gentle-speak'); assert.equal(sharedHome(io), '/real/.gentle-speak');
});
test('dotHome: GENTLE_DOT_HOME wins, else dirname(<Dot agent home>)/home', () => {
  assert.equal(dotHome({ env: {}, home: '/real' }), '/real/.gentle-dot/home');
  assert.equal(dotHome({ env: { GENTLE_DOT_AGENT_HOME: '/data/dot/agent' }, home: '/real' }), '/data/dot/home');
  assert.equal(dotHome({ env: { GENTLE_DOT_AGENT_HOME: '/data/dot/agent', GENTLE_DOT_HOME: '/elsewhere/h' }, home: '/real' }), '/elsewhere/h');
});
test('old terminal settings with dotSpeech/dotOffer still load', () => {
  const s = parseSpeakSettingsFile(file({ dotSpeech: true, dotOffer: 'declined' }));
  assert.equal(s?.dotSpeech, true); assert.equal(s?.dotOffer, 'declined');
});

type Opts = { as?: 'dot' | 'terminal'; terminal?: Record<string, unknown>; dotSpeak?: string | Record<string, unknown> | null; dotSettings?: string | null; select?: string[]; dotHomeEnv?: string; mode?: string };
function world(o: Opts = {}) {
  const base = mkdtempSync(join(tmpdir(), 'speak-dot-config-')); roots.push(base);
  const real = join(base, 'real'), shared = join(real, '.gentle-speak'), dotAgent = join(real, '.gentle-dot', 'agent');
  const dh = o.dotHomeEnv ?? join(real, '.gentle-dot', 'home'), dotSpeakDir = join(dh, '.gentle-speak'), dotSpeakFile = join(dotSpeakDir, 'speak-settings.json');
  const shell = join(real, '.gentle-shell', 'agent');
  for (const d of [shared, dotAgent, shell]) mkdirSync(d, { recursive: true });
  writeFileSync(join(shared, 'speak-settings.json'), file({ enabled: true, mode: 'all', voice: 'es_ES', speed: 1.25, macVoice: 'Paulina', macFallback: false, copySpeech: true, ...o.terminal }));
  if (o.dotSpeak !== undefined && o.dotSpeak !== null) { mkdirSync(dotSpeakDir, { recursive: true }); writeFileSync(dotSpeakFile, typeof o.dotSpeak === 'string' ? o.dotSpeak : file(o.dotSpeak)); }
  if (o.dotSettings !== null) writeFileSync(join(dotAgent, 'settings.json'), o.dotSettings ?? JSON.stringify({ packages: ['npm:pi-btw'] }, null, 2) + '\n');
  writeFileSync(join(shell, 'settings.json'), JSON.stringify({ packages: ['npm:gentle-speak@0.3.0'] }));
  const dot = o.as === 'dot';
  const env: Record<string, string | undefined> = dot ? { PI_CODING_AGENT_DIR: dotAgent, GENTLE_DOT_AGENT_HOME: dotAgent } : { PI_CODING_AGENT_DIR: shell, GENTLE_DOT_AGENT_HOME: dotAgent };
  if (o.dotHomeEnv) env.GENTLE_DOT_HOME = o.dotHomeEnv;
  const children: any[] = [], events = new Map<string, Function>(), commands = new Map<string, any>();
  const notes: string[] = [], selections = [...(o.select ?? [])], menus: string[][] = [];
  const spawn = () => {
    const c: any = Object.assign(new EventEmitter(), { writes: [] as string[], stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; } });
    c.stdin = { write: (l: string) => { c.writes.push(l); return true; } }; children.push(c); return c;
  };
  const ctx: any = { cwd: '/w', mode: dot ? (o.mode ?? 'rpc') : 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [{ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Resultado listo.' }] } }] },
    ui: { setStatus() {}, setWidget() {}, setTitle() {}, input: async () => undefined, notify: (t: string) => notes.push(t), confirm: async () => false,
      select: async (_t: string, items: string[]) => { menus.push(items); return selections.shift(); } } };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut() {}, registerTool() {} } as any, undefined, {
    modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn,
    focusCheck: async () => 'focused', focusPollMs: 5, lockPollMs: 5, sayAvailable: () => false, qwenStatus: async () => ({ manifest: 'missing', voices: {} }) as any,
    env, userHome: real, processHome: dot ? dh : real, packageRoot: '/pkg/gentle-speak', resolveTerminal: async () => undefined,
  } as any);
  const readDot = () => JSON.parse(readFileSync(dotSpeakFile, 'utf8'));
  const finish = (c: any) => c.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: JSON.parse(c.writes[0]).id }) + '\n');
  const menu = async (...choices: string[]) => { selections.push(...choices); await commands.get('speak').handler('', ctx); };
  return { base, real, shared, dotAgent, dotSpeakDir, dotSpeakFile, dh, ctx, notes, menus, children, events, readDot, finish, menu, selections,
    dotAgentFile: () => readFileSync(join(dotAgent, 'settings.json'), 'utf8'), backups: () => readdirSync(dotAgent).filter(n => n.includes('backup')),
    texts: () => children.filter(c => c.writes.length).map(c => JSON.parse(c.writes[0]).text), settle: () => events.get('agent_settled')!({ aborted: false }, ctx), shutdown: () => events.get('session_shutdown')!({}, ctx) };
}

test('terminal with HOME = real home is unchanged: settings, assets and lock all in ~/.gentle-speak', async () => {
  const w = world();
  const p = w.settle(); await until(() => w.texts().length === 1, 'speech');
  assert.ok(existsSync(join(w.shared, 'voice.lock')), 'lock in the shared home'); assert.equal(existsSync(w.dotSpeakDir), false);
  w.finish(w.children[0]); await p; w.shutdown();
});

test('Dot session reads settings from <dotHome>/.gentle-speak while the lock comes from the real home', async () => {
  const w = world({ as: 'dot', dotSpeak: { enabled: true, mode: 'all' }, terminal: { enabled: false } });
  const p = w.settle(); await until(() => w.texts().length === 1, 'speech');
  assert.deepEqual(w.texts(), ['Dot: Resultado listo.']);
  assert.ok(existsSync(join(w.shared, 'voice.lock')), 'lock in the real home'); assert.equal(existsSync(join(w.dotSpeakDir, 'voice.lock')), false);
  w.finish(w.children[0]); await p; w.shutdown();
});

test('Dot speaks only with its own enabled: the terminal enabled/dotSpeech have no effect; missing or malformed file means off', async () => {
  for (const dotSpeak of [{ enabled: false, mode: 'all' }, null, '{oops'] as const) {
    const w = world({ as: 'dot', dotSpeak, terminal: { enabled: true, dotSpeech: true } });
    await w.settle(); await quiet(); assert.deepEqual(w.children, [], `silent with ${JSON.stringify(dotSpeak)}`); w.shutdown();
  }
  const w = world({ as: 'dot', dotSpeak: { enabled: true, mode: 'all' }, terminal: { enabled: false, dotSpeech: false } });
  const p = w.settle(); await until(() => w.texts().length === 1); w.finish(w.children[0]); await p; w.shutdown();
});

test('connect seeds Dot settings from the terminal (0600 file, 0700 dir, copySpeech false, enabled true) after a backup', async () => {
  const w = world({ select: [] });
  await w.menu('Gentle Dot', 'Conectar Gentle Dot');
  const s = w.readDot();
  assert.equal(s.enabled, true); assert.equal(s.copySpeech, false); assert.equal(s.voice, 'es_ES'); assert.equal(s.mode, 'all'); assert.equal(s.speed, 1.25);
  assert.equal(s.macVoice, 'Paulina'); assert.equal(s.macFallback, false); assert.equal(s.summaryModel, null);
  assert.equal(statSync(w.dotSpeakFile).mode & 0o777, 0o600); assert.equal(statSync(w.dotSpeakDir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(w.dotSpeakDir), ['speak-settings.json'], 'no temp file left');
  assert.equal(w.backups().length, 1); assert.deepEqual(JSON.parse(w.dotAgentFile()).packages, ['npm:pi-btw', 'npm:gentle-speak@0.3.0']);
  assert.equal(parseSpeakSettingsFile(readFileSync(w.dotSpeakFile, 'utf8'))?.enabled, true);
  w.shutdown();
});

test('connect with an existing Dot settings file only sets enabled: true', async () => {
  const w = world({ dotSpeak: { enabled: false, mode: 'summary', voice: 'mac', speed: 0.8, copySpeech: false } });
  await w.menu('Gentle Dot', 'Conectar Gentle Dot');
  const s = w.readDot(); assert.equal(s.enabled, true); assert.equal(s.mode, 'summary'); assert.equal(s.voice, 'mac'); assert.equal(s.speed, 0.8); assert.equal(s.macVoice, null);
  w.shutdown();
});

test('connect refuses a malformed Dot speak file without touching Dot settings', async () => {
  const w = world({ dotSpeak: '{nope' });
  await w.menu('Gentle Dot', 'Conectar Gentle Dot');
  assert.equal(readFileSync(w.dotSpeakFile, 'utf8'), '{nope'); assert.deepEqual(w.backups(), []); assert.deepEqual(JSON.parse(w.dotAgentFile()).packages, ['npm:pi-btw']);
  assert.ok(w.notes.some(n => /mal formado/.test(n))); w.shutdown();
});

test('disconnect removes our entry after a backup and sets Dot enabled false, keeping the file and the rest', async () => {
  const w = world({ dotSpeak: { enabled: true, voice: 'es_ES', mode: 'summary' }, dotSettings: JSON.stringify({ packages: ['npm:pi-btw', '/x/gentle-speak'] }) });
  await w.menu('Gentle Dot', 'Desconectar Gentle Dot');
  assert.deepEqual(JSON.parse(w.dotAgentFile()).packages, ['npm:pi-btw']); assert.equal(w.backups().length, 1);
  const s = w.readDot(); assert.equal(s.enabled, false); assert.equal(s.mode, 'summary'); assert.equal(s.voice, 'es_ES');
  w.shutdown();
});

test('submenu shows the state and the top-level menu no longer has the dotSpeech item', async () => {
  const w = world({ dotSpeak: { enabled: true, mode: 'summary', voice: 'es_ES' }, dotSettings: JSON.stringify({ packages: ['/x/gentle-speak'] }) });
  await w.menu('Gentle Dot', 'Volver');
  assert.ok(!w.menus[0].includes('Hablar en Gentle Dot')); assert.ok(w.menus[0].includes('Gentle Dot'));
  assert.deepEqual(w.menus[1].slice(0, 6), ['Gentle Dot: conectado · habla: sí · voz es_ES · modo summary', 'Conectar Gentle Dot', 'Desconectar Gentle Dot', 'Hablar en Dot', 'Voz de Dot', 'Modo de Dot']);
  w.shutdown();
});
test('submenu state: not found and malformed', async () => {
  const a = world({ dotSettings: null }); await a.menu('Gentle Dot', 'Volver'); assert.match(a.menus[1][0], /no encontrado/); a.shutdown();
  const b = world({ dotSettings: '[]' }); await b.menu('Gentle Dot', 'Volver'); assert.match(b.menus[1][0], /mal formado/); b.shutdown();
  const c = world({ dotSpeak: '{x' }); await c.menu('Gentle Dot', 'Volver'); assert.match(c.menus[1][0], /mal formado/); c.shutdown();
});

test('Hablar en Dot toggles Dot enabled atomically and leaves the terminal settings alone', async () => {
  const w = world({ dotSpeak: { enabled: false, mode: 'all' } });
  const before = readFileSync(join(w.shared, 'speak-settings.json'), 'utf8');
  await w.menu('Gentle Dot', 'Hablar en Dot'); assert.equal(w.readDot().enabled, true);
  await w.menu('Gentle Dot', 'Hablar en Dot'); assert.equal(w.readDot().enabled, false);
  assert.equal(readFileSync(join(w.shared, 'speak-settings.json'), 'utf8'), before); assert.deepEqual(readdirSync(w.dotSpeakDir), ['speak-settings.json']); w.shutdown();
});
test('Modo de Dot and Voz de Dot (including Mac) write Dot settings only', async () => {
  const w = world({ dotSpeak: { enabled: true, mode: 'all', voice: 'es_MX' } });
  await w.menu('Gentle Dot', 'Modo de Dot', 'summary'); assert.equal(w.readDot().mode, 'summary');
  await w.menu('Gentle Dot', 'Voz de Dot', 'Voice: Español (España) (es_ES) — installed'); assert.equal(w.readDot().voice, 'es_ES');
  const mac = w.menus.at(-1)!.find(t => t.includes('(mac)')); assert.ok(mac, 'Mac is in the voice catalog');
  assert.equal(JSON.parse(readFileSync(join(w.shared, 'speak-settings.json'), 'utf8')).voice, 'es_ES'); // terminal's own value untouched
  w.shutdown();
});
test('submenu actions refuse a malformed Dot settings file with a notice and keep it', async () => {
  for (const action of [['Hablar en Dot'], ['Modo de Dot', 'summary'], ['Desconectar Gentle Dot']]) {
    const w = world({ dotSpeak: '{bad', dotSettings: JSON.stringify({ packages: ['/x/gentle-speak'] }) });
    await w.menu('Gentle Dot', ...action);
    assert.equal(readFileSync(w.dotSpeakFile, 'utf8'), '{bad'); assert.ok(w.notes.some(n => /mal formado/.test(n)), action[0]); w.shutdown();
  }
});
test('Hablar en Dot with no Dot speak file yet seeds one from the terminal', async () => {
  const w = world();
  await w.menu('Gentle Dot', 'Hablar en Dot'); const s = w.readDot(); assert.equal(s.enabled, true); assert.equal(s.voice, 'es_ES'); assert.equal(s.copySpeech, false); w.shutdown();
});

test('GENTLE_DOT_HOME overrides where Dot settings live', async () => {
  const w = world({ dotHomeEnv: join(tmpdir(), `speak-dot-custom-${process.pid}`) }); roots.push(w.dh);
  await w.menu('Gentle Dot', 'Conectar Gentle Dot');
  assert.equal(w.dotSpeakFile.startsWith(w.dh), true); assert.equal(w.readDot().enabled, true); assert.equal(existsSync(join(w.real, '.gentle-dot', 'home')), false); w.shutdown();
});
