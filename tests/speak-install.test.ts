import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installSpeakModel, readSpeakModelStatus, SPEAK_MODELS, installSpeakRuntime, readSpeakRuntimeStatus, speakRuntimeManifest, SPEAK_TARGETS, type SpeakModelManifest, type SpeakRuntimeManifest } from '../lib/speak-install.ts';

const manifest: SpeakModelManifest = SPEAK_MODELS.es_MX;
const bytes = await readFile(join(process.cwd(), '.local-models', manifest.files[0]!.name));
assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[0]!.sha256);
const home = async (run: (path: string) => Promise<void>) => { const path = await mkdtemp(join(tmpdir(), 'speak-install-')); try { await run(path); } finally { await rm(path, { recursive: true, force: true }); } };
const response = (body = bytes) => new Response(body, { headers: { 'content-length': String(body.length) } });

test('official converted bundle pins and public install produce sherpa model layout', () => home(async path => {
  for (const [voice, expected] of [['es_MX', 'ec33fb689c248fe64810aab564cba97babf0f506672cfd404928d46e751a4721'], ['es_ES', 'a3f6beb54a9cb893279f72978a22f807a4d9fc9c7848157b524d5cc7b7f58b22']] as const) {
    const pin = SPEAK_MODELS[voice];
    const archive = await readFile(join(process.cwd(), '.local-models', pin.files[0]!.name));
    assert.equal(createHash('sha256').update(archive).digest('hex'), expected);
    assert.equal(pin.files[0]!.sha256, expected);
    const installed = await installSpeakModel({ home: path, voice, confirmed: true, fetch: async () => response(archive) });
    for (const name of [`${voice === 'es_MX' ? 'es_MX-claude-high' : 'es_ES-davefx-medium'}.onnx`, 'tokens.txt', 'espeak-ng-data', 'MODEL_CARD']) {
      assert.ok((await readdir(installed.path)).includes(name));
    }
    assert.equal((await readSpeakModelStatus({ home: path, voice })).state, 'installed');
  }
}));

test('explicit confirmation gates model acquisition; valid bytes publish once', () => home(async path => {
  let calls = 0;
  const fetch = async () => { calls++; return response(); };
  await assert.rejects(installSpeakModel({ home: path, manifest, fetch }), /confirmation/i);
  assert.equal(calls, 0);
  assert.equal((await readSpeakModelStatus({ home: path, manifest })).state, 'missing');
  const result = await installSpeakModel({ home: path, manifest, confirmed: true, fetch });
  assert.equal(result.alreadyInstalled, false);
  assert.ok((await readdir(result.path)).includes('tokens.txt'));
  assert.equal((await readSpeakModelStatus({ home: path, manifest })).state, 'installed');
  assert.equal((await installSpeakModel({ home: path, manifest, confirmed: true, fetch })).alreadyInstalled, true);
  await writeFile(join(result.path, 'tokens.txt'), 'corrupted');
  assert.equal((await readSpeakModelStatus({ home: path, manifest })).state, 'invalid');
  await assert.rejects(installSpeakModel({ home: path, manifest, confirmed: true, fetch }), /invalid/i);
  assert.equal(calls, 2);
}));

test('bad digest and cancellation cannot publish or leave staging', () => home(async path => {
  const bad = { ...manifest, files: [{ ...manifest.files[0]!, sha256: '0'.repeat(64) }] };
  await assert.rejects(installSpeakModel({ home: path, manifest: bad, confirmed: true, fetch: async () => response() }), /digest|integrity/i);
  assert.equal((await readSpeakModelStatus({ home: path, manifest: bad })).state, 'missing');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(installSpeakModel({ home: path, manifest, confirmed: true, signal: controller.signal, fetch: async () => response() }), /cancel/i);
  assert.deepEqual(await readdir(path), []);
}));

test('runtime requires confirmation and rejects unsupported targets before fetch or filesystem writes', () => home(async path => {
  let calls = 0;
  const fetch = async () => { calls++; return response(); };
  assert.deepEqual(SPEAK_TARGETS, ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64']);
  for (const target of SPEAK_TARGETS) {
    const pin = speakRuntimeManifest(target);
    assert.equal(pin.packages.length, 3);
    assert.ok(pin.packages[0]!.requiredFiles.includes('non-streaming-tts.js'));
    await assert.rejects(installSpeakRuntime({ home: path, target, fetch }), /confirmation/i);
  }
  await assert.rejects(installSpeakRuntime({ home: path, target: 'freebsd-x64' as never, confirmed: true, fetch }), /unsupported/i);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(path), []);
}));

function archive(paths: string[]): Buffer {
  const blocks: Buffer[] = [];
  for (const path of paths) {
    const header = Buffer.alloc(512);
    header.write(`package/${path}`, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write('00000000001\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156); header.write('ustar\0', 257);
    const sum = header.reduce((n, b) => n + b, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, Buffer.concat([Buffer.from('x'), Buffer.alloc(511)]));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function fixtureRuntime(paths: string[][] = [['package.json', 'non-streaming-tts.js'], ['package.json', 'sherpa-onnx.node'], ['package.json', 'bin/darwin-arm64/index.node']]): { manifest: SpeakRuntimeManifest; bodies: Buffer[] } {
  const bodies = paths.map(archive);
  const packages = speakRuntimeManifest('darwin-arm64').packages.map((pkg, index) => ({ ...pkg,
    size: bodies[index]!.length, integrity: `sha512-${createHash('sha512').update(bodies[index]!).digest('base64')}`,
    unpackedSize: 1024, fileCount: 10, requiredFiles: paths[index]!,
  }));
  return { manifest: { id: 'fixture-runtime', target: 'darwin-arm64', packages }, bodies };
}
test('runtime verifies three tarballs before extraction and publishes complete sibling package layout', () => home(async path => {
  const { manifest, bodies } = fixtureRuntime(); let calls = 0;
  const fetch = async () => response(bodies[calls++]!);
  const installed = await installSpeakRuntime({ home: path, target: 'darwin-arm64', manifest, confirmed: true, fetch });
  assert.equal(installed.alreadyInstalled, false);
  assert.equal(calls, 3);
  assert.equal((await readSpeakRuntimeStatus({ home: path, target: 'darwin-arm64', manifest })).state, 'installed');
  assert.equal((await readFile(join(installed.path, 'node_modules/sherpa-onnx-node/non-streaming-tts.js'), 'utf8')), 'x');
  const binary = join(installed.path, 'node_modules/node-cpal/bin/darwin-arm64/index.node');
  assert.equal((await readFile(binary, 'utf8')), 'x');
  await writeFile(binary, 'y');
  assert.equal((await readSpeakRuntimeStatus({ home: path, target: 'darwin-arm64', manifest })).state, 'invalid');
  await writeFile(binary, 'x');
  assert.equal((await installSpeakRuntime({ home: path, target: 'darwin-arm64', manifest, confirmed: true, fetch })).alreadyInstalled, true);
  assert.equal(calls, 3);
}));

test('runtime rejects bad integrity, unsafe archive entries and cancellation without publication', () => home(async path => {
  const { manifest, bodies } = fixtureRuntime();
  const bad = { ...manifest, packages: manifest.packages.map((pkg, i) => i === 1 ? { ...pkg, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } : pkg) };
  let calls = 0;
  await assert.rejects(installSpeakRuntime({ home: path, target: 'darwin-arm64', manifest: bad, confirmed: true, fetch: async () => response(bodies[calls++]!) }), /digest/i);
  assert.equal((await readSpeakRuntimeStatus({ home: path, target: 'darwin-arm64', manifest: bad })).state, 'missing');
  const unsafe = fixtureRuntime([['package.json', '../escape'], ['package.json'], ['package.json']]);
  unsafe.manifest.packages[0]!.requiredFiles = ['package.json']; calls = 0;
  await assert.rejects(installSpeakRuntime({ home: path, target: 'darwin-arm64', manifest: unsafe.manifest, confirmed: true, fetch: async () => response(unsafe.bodies[calls++]!) }), /unsafe archive/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(installSpeakRuntime({ home: path, target: 'darwin-arm64', manifest, confirmed: true, signal: controller.signal, fetch: async () => response() }), /cancel/i);
  assert.deepEqual(await readdir(path), []);
}));

test('abort between initial check and signal subscription prevents both installers from writing', () => home(async path => {
  for (const runtime of [false, true]) {
    const controller = new AbortController();
    const subscribe = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      controller.abort();
      return subscribe(...args);
    }) as AbortSignal['addEventListener'];
    let calls = 0;
    const fetch = async () => { calls++; return response(); };
    const install = runtime
      ? installSpeakRuntime({ home: path, target: 'darwin-arm64', confirmed: true, signal: controller.signal, fetch })
      : installSpeakModel({ home: path, manifest, confirmed: true, signal: controller.signal, fetch });
    await assert.rejects(install, /cancel/i);
    assert.equal(calls, 0);
  }
  assert.deepEqual(await readdir(path), []);
}));

test('abort at the final progress callback prevents model and runtime publication', () => home(async path => {
  const modelAbort = new AbortController();
  await assert.rejects(installSpeakModel({ home: path, manifest, confirmed: true, signal: modelAbort.signal,
    fetch: async () => response(), onProgress: () => modelAbort.abort() }), /cancel/i);
  assert.equal((await readSpeakModelStatus({ home: path, manifest })).state, 'missing');
  const fixture = fixtureRuntime(); let calls = 0;
  const runtimeAbort = new AbortController();
  await assert.rejects(installSpeakRuntime({ home: path, target: 'darwin-arm64', manifest: fixture.manifest,
    confirmed: true, signal: runtimeAbort.signal, fetch: async () => response(fixture.bodies[calls++]!),
    onProgress: (received, total) => { if (received === total) runtimeAbort.abort(); } }), /cancel/i);
  assert.equal((await readSpeakRuntimeStatus({ home: path, target: 'darwin-arm64', manifest: fixture.manifest })).state, 'missing');
  assert.deepEqual(await readdir(path), []);
}));

test('forged empty runtime marker is invalid and does not suppress installation', () => home(async path => {
  const fixture = fixtureRuntime();
  const installed = await installSpeakRuntime({ home: path, target: 'darwin-arm64', manifest: fixture.manifest,
    confirmed: true, fetch: async () => response(fixture.bodies.shift()!) });
  const marker = join(installed.path, '.gentle-speak-runtime.json');
  const forged = JSON.parse(await readFile(marker, 'utf8'));
  forged.files = [];
  await writeFile(marker, JSON.stringify(forged));
  assert.equal((await readSpeakRuntimeStatus({ home: path, target: 'darwin-arm64', manifest: fixture.manifest })).state, 'invalid');
}));

test('two concurrent valid model installs converge without replacing published payload', () => home(async path => {
  let started = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const fetch = async () => { if (++started === 2) release(); await barrier; return response(); };
  const results = await Promise.all([1, 2].map(() => installSpeakModel({ home: path, manifest, confirmed: true, fetch })));
  assert.deepEqual(results.map(result => result.alreadyInstalled).sort(), [false, true]);
  assert.equal((await readSpeakModelStatus({ home: path, manifest })).state, 'installed');
}));

test('two concurrent valid runtime installs converge without replacing published payload', () => home(async path => {
  const fixture = fixtureRuntime();
  let started = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const fetch = async (url: string) => {
    if (++started === 2) release();
    await barrier;
    const index = fixture.manifest.packages.findIndex(pkg => pkg.tarball === url);
    assert.notEqual(index, -1);
    return response(fixture.bodies[index]!);
  };
  const results = await Promise.all([1, 2].map(() => installSpeakRuntime({ home: path, target: 'darwin-arm64',
    manifest: fixture.manifest, confirmed: true, fetch })));
  assert.deepEqual(results.map(result => result.alreadyInstalled).sort(), [false, true]);
  assert.equal((await readSpeakRuntimeStatus({ home: path, target: 'darwin-arm64', manifest: fixture.manifest })).state, 'installed');
}));

test('oversized and redirected payloads are refused without publishing', () => home(async path => {
  await assert.rejects(installSpeakModel({ home: path, manifest, confirmed: true, fetch: async () => response(Buffer.concat([bytes, bytes])) }), /size|bytes/i);
  await assert.rejects(installSpeakModel({ home: path, manifest, confirmed: true, fetch: async () => new Response(null, { status: 302, headers: { location: 'http://evil.example/file' } }) }), /redirect/i);
  assert.equal((await readSpeakModelStatus({ home: path, manifest })).state, 'missing');
}));
