import './helpers/guard-real-home.ts';
// T40 / S13 (L83): the shared service stays loaded while sessions are open, sessions keep one presence connection, and a grace
// countdown starts at the LAST disconnect. Real unix sockets in a temp shared home; the Python is a fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQwenSpeech } from '../lib/speak-qwen.ts';
import { compareQwenServiceVersions, connectQwenService, stopQwenService } from '../lib/speak-qwen-service.ts';
import { createQwenServiceSpawner } from '../lib/speak-qwen-client.ts';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, parseSpeakSettingsFile } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';
import { qwenFixture, rawClient, until } from './helpers/qwen-service-fixture.ts';

type Fx = ReturnType<typeof qwenFixture>;
const synth = (fx: Fx, id: number, text: string, outDir: string) => ({ type: 'synth', id, priority: 'speak', text, ref: fx.ref, refText: 'ref', outDir, speed: 1 });
async function client(fx: Fx, extra = {}) {
  const connection = await connectQwenService(fx.options({ exitIdleMs: undefined, ...extra }));
  connection.socket.setEncoding('utf8');
  return { ...rawClient(connection.socket, connection.rest), pid: connection.pid };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const base = (fx: Fx) => ({ python: fx.options().python, ref: fx.ref, refText: 'ref', speed: 1 });

// ---- 1. loaded while sessions are open ----
test('a connected client with no requests keeps the service and its Python loaded past the idle time, and the next request does not reload', async () => {
  const fx = qwenFixture();
  try {
    const c = await client(fx, { idleMs: 300 });
    c.send(synth(fx, 1, 'hola', fx.outDir()));
    await c.waitFor(m => m.some(x => x.type === 'done'));
    const [py] = fx.workerPids();
    await sleep(1200); // four times the idle
    assert.equal(fx.isAlive(py), true, 'python still loaded');
    assert.equal(fx.isAlive(c.pid), true, 'service still up');
    c.send(synth(fx, 2, 'otra', fx.outDir()));
    await c.waitFor(m => m.some(x => x.id === 2 && x.type === 'done'));
    assert.equal(fx.workerPids().length, 1, 'no reload');
  } finally { await fx.close(); }
});

// ---- 3. grace counts from the last disconnect ----
test('grace is measured from the last disconnect, not from the last request; unload + exit remove socket and pid', async () => {
  const fx = qwenFixture();
  try {
    const a = await client(fx, { idleMs: 1200 }), b = await client(fx, { idleMs: 1200 });
    a.send(synth(fx, 1, 'hola', fx.outDir()));
    await a.waitFor(m => m.some(x => x.type === 'done'));
    const [py] = fx.workerPids(), service = a.pid;
    await sleep(1500); // the last request is now older than the grace
    a.socket.destroy();
    await sleep(300);
    assert.equal(fx.isAlive(service), true, 'one client left: nothing happens');
    b.socket.destroy();
    const t0 = Date.now();
    await sleep(600);
    assert.equal(fx.isAlive(service), true, 'only 600 ms after the last disconnect');
    assert.equal(fx.isAlive(py), true);
    await until(() => !fx.isAlive(service), 'service exit after the grace', 6000);
    const took = Date.now() - t0;
    assert.ok(took >= 1000, `exited ${took} ms after the last disconnect (grace 1200)`);
    assert.equal(fx.isAlive(py), false, 'python unloaded');
    assert.equal(existsSync(fx.paths.socket), false); assert.equal(existsSync(fx.paths.pid), false);
  } finally { await fx.close(); }
});

// ---- 4. a new connection cancels the grace ----
test('a new connection during the grace cancels it, and the countdown restarts at the next last disconnect', async () => {
  const fx = qwenFixture();
  try {
    const a = await client(fx, { idleMs: 1200 });
    const service = a.pid;
    a.socket.destroy();
    await sleep(500);
    const b = await client(fx, { idleMs: 1200 });
    assert.equal(b.pid, service, 'same service');
    await sleep(1500); // past the original expiry
    assert.equal(fx.isAlive(service), true, 'grace cancelled');
    b.socket.destroy();
    const t0 = Date.now();
    await until(() => !fx.isAlive(service), 'exit after the second grace', 6000);
    assert.ok(Date.now() - t0 >= 1000, 'a fresh full grace');
  } finally { await fx.close(); }
});

// ---- 6. never / test override ----
test('never: the service stays after the last disconnect; --exit-idle-ms still overrides the grace for tests', async () => {
  const fx = qwenFixture();
  try {
    const a = await client(fx, { idleMs: null });
    a.socket.destroy();
    await sleep(900);
    assert.equal(fx.isAlive(a.pid), true);
    await stopQwenService(fx.home);
    await until(() => !fx.isAlive(a.pid), 'stopped');
    const b = await client(fx, { idleMs: 600_000, exitIdleMs: 400 });
    b.socket.destroy();
    await until(() => !fx.isAlive(b.pid), 'exit-idle-ms override', 4000);
  } finally { await fx.close(); }
});

// ---- 2. presence connection ----
test('a service session keeps one connection across the T37 idle close of its worker, and closes it cleanly on close()', async () => {
  const fx = qwenFixture();
  try {
    const spawner = createQwenServiceSpawner({ ...fx.options({ idleMs: 500, exitIdleMs: undefined }), spawnLocal: () => { throw new Error('no local'); } });
    const speech = createQwenSpeech({ tmpRoot: fx.root, spawnPython: spawner, spawnAudio: () => { throw new Error('no audio'); }, idleMs: 150 } as any);
    assert.equal((await speech.prepare({ ...base(fx), text: 'Hola.' })).ok, true);
    const service = fx.pidOf()!, [py] = fx.workerPids();
    await sleep(1800); // session idle 150 ms and service grace 500 ms are both long gone
    assert.equal(fx.isAlive(service), true, 'the presence connection survived the session idle close');
    assert.equal(fx.isAlive(py), true);
    assert.equal((await speech.prepare({ ...base(fx), text: 'Otra.' })).ok, true);
    assert.equal(fx.workerPids().length, 1, 'same Python, same service');
    speech.dispose();
    assert.equal(fx.isAlive(service), true, 'dispose alone keeps presence until the session closes it');
    (spawner as any).close();
    await until(() => !fx.isAlive(service), 'service exits one grace after the session closed its connection', 6000);
  } finally { await fx.close(); }
});

test('a dropped presence connection reconnects at the next need, restarting the service once if it is gone', async () => {
  const fx = qwenFixture();
  try {
    const spawner = createQwenServiceSpawner({ ...fx.options({ idleMs: null, exitIdleMs: undefined }), spawnLocal: () => { throw new Error('no local'); } });
    const speech = createQwenSpeech({ tmpRoot: fx.root, spawnPython: spawner, spawnAudio: () => { throw new Error('no audio'); }, idleMs: null } as any);
    assert.equal((await speech.prepare({ ...base(fx), text: 'Hola.' })).ok, true);
    const first = fx.pidOf()!;
    await stopQwenService(fx.home); // "Detener servicio Qwen"
    await until(() => !fx.isAlive(first), 'stopped');
    await sleep(500);
    assert.equal(fx.pidOf() === undefined || !fx.isAlive(fx.pidOf()), true, 'not restarted in the background: a stop stays stopped until the next need');
    assert.equal((await speech.prepare({ ...base(fx), text: 'Otra.' })).ok, true);
    const second = fx.pidOf()!;
    assert.notEqual(second, first); assert.equal(fx.isAlive(second), true);
    speech.dispose(); (spawner as any).close();
  } finally { await fx.close(); }
});

test('the local fallback worker keeps the T37 per-session idle close', async () => {
  const fx = qwenFixture();
  try {
    let killed = 0;
    const spawnLocal = () => { const child: any = Object.assign(new EventEmitter(), { stdin: { write: () => true, end() {} }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { killed++; return true; } }); setImmediate(() => child.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak.qwen/v1', type: 'ready' }) + '\n')); return child; };
    const spawner = createQwenServiceSpawner({ ...fx.options(), spawnLocal, connect: async () => { throw new Error('no service'); } });
    const speech = createQwenSpeech({ tmpRoot: fx.root, spawnPython: spawner, spawnAudio: () => { throw new Error('no audio'); }, idleMs: 200 } as any);
    const pending = speech.prepare({ ...base(fx), text: 'Hola.' });
    await sleep(100);
    pending.handle.cancel();
    await pending;
    await until(() => killed >= 1, 'local worker closed by the session idle', 3000);
  } finally { await fx.close(); }
});

// ---- extension: presence from first speech to session_shutdown ----
const fakeAudio = () => {
  const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; },
    stdin: { write: (line: string) => { const m = JSON.parse(line); if (m.type === 'play') setImmediate(() => child.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: m.id }) + '\n')); return true; }, end() {} } });
  return child;
};
test('the extension holds the connection from its first speech until session_shutdown', async () => {
  const fx = qwenFixture();
  try {
    writeFileSync(join(fx.home, 'voices', 'qwen3', 'qwen3-chain-l3.wav'), 'RIFF');
    writeFileSync(join(fx.home, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ python: fx.options().python }));
    writeFileSync(join(fx.home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, voice: 'qwen-intima', qwenIdleMinutes: 1 }));
    const tools = new Map<string, any>(), events = new Map<string, Function>();
    const ctx: any = { mode: 'tui', hasUI: true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [] }, ui: { notify() {}, setStatus() {}, select: async () => undefined } };
    const { python: _p, idleMs: _i, ...service } = fx.options({ exitIdleMs: 700 });
    const deps = { ...hermetic(fx.home), modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }),
      qwenStatus: async () => ({ manifest: 'valid', voices: { 'qwen-intima': 'installed' } }), spawn: () => fakeAudio(), qwenTmpRoot: fx.root, focusCheck: async () => 'focused', sayAvailable: () => false, qwenService: service };
    gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand() {}, registerShortcut() {}, registerTool: (t: any) => tools.set(t.name, t) } as any, fx.home, deps as any);
    await tools.get('speak').execute('id', { text: 'Hola desde la sesión.' }, undefined, undefined, ctx);
    const pid = fx.pidOf()!;
    await sleep(1800);
    assert.equal(fx.isAlive(pid), true, 'connected between speeches');
    events.get('session_shutdown')?.({}, ctx);
    await until(() => !fx.isAlive(pid), 'service left after its grace once the session shut down', 6000);
  } finally { await fx.close(); }
});

// ---- 4. setting ----
test('qwenIdleMinutes defaults to 10; an absent value loads as 10, an explicit one is respected', () => {
  assert.equal((DEFAULT_SPEAK_SETTINGS as any).qwenIdleMinutes, 10);
  const { qwenIdleMinutes: _q, ...old } = DEFAULT_SPEAK_SETTINGS as any;
  assert.equal(parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...old }))?.qwenIdleMinutes, 10);
  for (const explicit of [5, 1, 60, null]) assert.equal(parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...old, qwenIdleMinutes: explicit }))?.qwenIdleMinutes, explicit);
});

test('/speak labels the setting «Mantener Qwen tras cerrar la última sesión» with 1, 2, 5, 10, 30, 60 min and Nunca', async () => {
  const home = mkdtempSync(join(tmpdir(), 'speak-presence-menu-'));
  try {
    mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true });
    writeFileSync(join(home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, voice: 'qwen-intima' }));
    const commands = new Map<string, any>(), offered: string[][] = [], titles: string[] = [], picks = ['Mantener Qwen tras cerrar la última sesión', '2 min'];
    const ctx: any = { mode: 'tui', hasUI: true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [] }, ui: { notify() {}, setStatus() {}, select: async (t: string, o: string[]) => { titles.push(t); offered.push(o); return picks.shift(); } } };
    const deps = { ...hermetic(home), spawnQwen: () => { throw new Error('unused'); }, modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), qwenStatus: async () => ({ manifest: 'valid', voices: { 'qwen-intima': 'installed' } }), focusCheck: async () => 'focused', sayAvailable: () => false };
    gentleSpeak({ on() {}, registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut() {}, registerTool() {} } as any, home, deps as any);
    await commands.get('speak').handler('', ctx);
    assert.ok(offered[0].includes('Mantener Qwen tras cerrar la última sesión'));
    assert.ok(!offered[0].includes('Liberar Qwen tras inactividad'));
    assert.equal(titles[1], 'Mantener Qwen tras cerrar la última sesión');
    assert.deepEqual(offered[1], ['1 min', '2 min', '5 min', '10 min', '30 min', '60 min', 'Nunca']);
    assert.equal(JSON.parse(readFileSync(join(home, 'speak-settings.json'), 'utf8')).qwenIdleMinutes, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ---- 5. semver prerelease order ----
test('R3-prerelease-order: a prerelease sorts before its release, identifiers compare per semver, then the protocol revision', () => {
  const v = compareQwenServiceVersions;
  assert.equal(v('1.0.0-beta+p1', '1.0.0+p1'), -1);
  assert.equal(v('1.0.0+p1', '1.0.0-beta+p1'), 1);
  assert.equal(v('1.0.0-beta+p1', '1.0.0-beta+p1'), 0);
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i + 1 < chain.length; i++) { assert.equal(v(`${chain[i]}+p1`, `${chain[i + 1]}+p1`), -1, `${chain[i]} < ${chain[i + 1]}`); assert.equal(v(`${chain[i + 1]}+p1`, `${chain[i]}+p1`), 1); }
  assert.equal(v('1.0.0-beta+p2', '1.0.0-beta+p1'), 1, 'equal prerelease: the protocol revision decides');
  assert.equal(v('1.0.0-beta+p1', '1.0.0-beta+p2'), -1);
  assert.equal(v('1.0.1-beta+p1', '1.0.0+p9'), 1, 'the numeric core still decides first');
  assert.equal(v('2.0.0+p1', '1.9.9+p1'), 1);
});
