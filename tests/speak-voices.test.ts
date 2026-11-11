import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, VOICE_CATALOG, parseSpeakSettingsFile, readSpeakSettings, writeSpeakSettings } from '../lib/speak-settings.ts';
import { QWEN_MODEL_ID, QWEN_PYTHON_FLAGS, QWEN_VOICES } from '../lib/speak-voices.ts';
import { installQwenVoices, qwenVoicesStatus } from '../lib/speak-voices-install.ts';

const TEXT_A = '¿Ya estás despierto? Mira, te tengo una noticia buena y una mala, y voy a empezar por la buena, porque me cae bien tu cara. Terminé todo. Sí, todo, y sin quejarme ni una sola vez... bueno, casi ninguna. Ahora la mala: vas a tener que revisar lo que hice, y sé que eso te da pereza. Ven, siéntate. Escúchame un segundo y me dices si te convence, ¿va?';
const TEXT_B = TEXT_A.replace('Escúchame', 'Escuchame').replace('me dices', 'me decis');
const TEXT_C = 'Encontré el problema. Era una carrera en el worker de audio, algo tonto en realidad. Ya está arreglado.';
const EXPECTED: Record<string, [string, string, string, string, number]> = {
  'qwen-suave': ['Suave', 'f3-suave.wav', TEXT_A, 'd2bddd57ef9268065b53b7c42a6d1051a438e00c1c519bb9cac275699ca3a48a', 1080130],
  'qwen-brisa': ['Brisa', 'f2-brisa.wav', TEXT_A, '06c7fcebab6715a5bcbb9c60b50da4d2c2d69c82cba33d0abeaaadd3dfb586f0', 1080694],
  'qwen-coqueta': ['Coqueta', 'qwen3-vd-v3h-x.wav', TEXT_B, '89dca671b7d0d49b0a6c3fa0e7abccced663c9a4ce0ecb3754aeb4e91806a745', 1662764],
  'qwen-maestra': ['Maestra', 'qwen3-vd-v3h-t1.wav', TEXT_B, 'c4610abc3b8acabf631d6ac5eeb3f9bb2256036619af3286360c39cb127e348e', 1731884],
  'qwen-intima': ['Íntima', 'qwen3-chain-l3.wav', TEXT_C, '9a4523fa9358accfb20bafc8c04d42c4b00a0356fe41e18204dce6e4bd27e327', 364844],
  'qwen-serena': ['Serena', 'qwen3-vd-v3h-t1-frio3.wav', TEXT_C, '79518f55c129eba1df27226b99ad1f136a7ef3f14dc56e162869c1a934db4219', 430124],
  'qwen-viva': ['Viva', 'qwen3-vd-v3h-t1-s7-linea3.wav', TEXT_C, '2461137825aab2f80d88bcd3787e88e3a4e71d19060cb70738ed8172c8070cbf', 564524],
};

const tmp = async (run: (dir: string) => unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'gentle-speak-voices-'));
  try { await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

test('catalog has exactly the seven qwen voices with exact files, transcripts and hashes; piper entries unchanged', () => {
  const qwen = Object.entries(VOICE_CATALOG).filter(([, v]) => v.engine === 'qwen3');
  assert.deepEqual(qwen.map(([id]) => id).sort(), Object.keys(EXPECTED).sort());
  for (const [id, voice] of qwen) {
    const [label, file, transcript, hash, bytes] = EXPECTED[id];
    assert.deepEqual({ ...voice }, { engine: 'qwen3', label, file, transcript, sha256: hash, bytes });
  }
  assert.deepEqual({ ...VOICE_CATALOG.es_MX }, { engine: 'piper', locale: 'es_MX', language: 'es', label: 'Español (México)' });
  assert.deepEqual({ ...VOICE_CATALOG.es_ES }, { engine: 'piper', locale: 'es_ES', language: 'es', label: 'Español (España)' });
  assert.deepEqual({ ...VOICE_CATALOG.mac }, { engine: 'system', label: 'Mac' });
  assert.equal(Object.keys(VOICE_CATALOG).length, 10);
  assert.equal(Object.keys(QWEN_VOICES).length, 7);
  assert.equal(QWEN_MODEL_ID, 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16');
});

test('settings accept every catalog voice and round-trip a qwen voice; default stays es_MX', () => tmp(home => {
  assert.equal(DEFAULT_SPEAK_SETTINGS.voice, 'es_MX');
  for (const voice of Object.keys(VOICE_CATALOG)) {
    const settings = { ...DEFAULT_SPEAK_SETTINGS, voice };
    writeSpeakSettings(settings, home);
    assert.deepEqual(readSpeakSettings(home), settings);
  }
}));

test('v1 file without cycleVoice loads unchanged plus the default; cycleVoice is ctrl+alt+n', () => {
  assert.equal(DEFAULT_SPEAK_SETTINGS.shortcuts.cycleVoice, 'ctrl+alt+n');
  const shortcuts = { speakLast: 'ctrl+alt+s', stop: 'ctrl+alt+x', toggle: 'ctrl+alt+t' };
  const v1 = { schema: SPEAK_SETTINGS_SCHEMA, enabled: true, mode: 'summary', voice: 'es_ES', speed: 1.25, shortcuts };
  assert.deepEqual(parseSpeakSettingsFile(JSON.stringify(v1)), { enabled: true, mode: 'summary', voice: 'es_ES', speed: 1.25, summaryModel: null, copySpeech: false, macVoice: null, macFallback: true, dotSpeech: false, dotOffer: null, shortcuts: { ...shortcuts, cycleVoice: 'ctrl+alt+n', toggleCopy: 'ctrl+alt+c' } });
});

test('unknown voice, reserved, duplicate and malformed cycleVoice stay rejected', () => {
  const base = { schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS };
  const parse = (patch: object) => parseSpeakSettingsFile(JSON.stringify({ ...base, ...patch }));
  assert.ok(parse({}));
  assert.equal(parse({ voice: 'unknown' }), undefined);
  for (const cycleVoice of ['ctrl+k', 'alt+a', DEFAULT_SPEAK_SETTINGS.shortcuts.toggle, 'n', 7]) {
    assert.equal(parse({ shortcuts: { ...DEFAULT_SPEAK_SETTINGS.shortcuts, cycleVoice } }), undefined);
  }
  assert.equal(parse({ shortcuts: { ...DEFAULT_SPEAK_SETTINGS.shortcuts, extra: 'ctrl+alt+q' } }), undefined);
  assert.throws(() => writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, shortcuts: { ...DEFAULT_SPEAK_SETTINGS.shortcuts, cycleVoice: 'ctrl+alt+v' } }, '/nonexistent-never-written'), /Invalid speak settings/);
});

// Fixture catalog with tiny files.
const fixture = (dir: string) => {
  const files = { 'a.wav': Buffer.from('alpha-audio'), 'b.wav': Buffer.from('beta-audio!!') };
  const source = join(dir, 'src');
  mkdirSync(source);
  for (const [name, data] of Object.entries(files)) writeFileSync(join(source, name), data);
  const catalog = {
    'qwen-a': { engine: 'qwen3' as const, label: 'A', file: 'a.wav', transcript: 'Hola á', sha256: sha(files['a.wav']), bytes: files['a.wav'].length },
    'qwen-b': { engine: 'qwen3' as const, label: 'B', file: 'b.wav', transcript: 'Adiós ¿?', sha256: sha(files['b.wav']), bytes: files['b.wav'].length },
  };
  return { source, catalog, home: join(dir, 'home') };
};
const okRun = () => { const calls: string[][] = []; return { calls, run: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0 }; } }; };

test('installer copies, verifies and writes a manifest in a temp home', () => tmp(async dir => {
  const { source, catalog, home } = fixture(dir);
  assert.deepEqual((await qwenVoicesStatus(home, catalog)).voices, { 'qwen-a': 'missing', 'qwen-b': 'missing' });
  const { calls, run } = okRun();
  await installQwenVoices({ sourceDir: source, home, python: '/py/python3', catalog, run });
  // Same interpreter flags the synth worker runs with, and the import that
  // actually loads the model: a bare `import mlx_audio` passed even when
  // load_model failed for lack of user-site dependencies.
  assert.deepEqual(QWEN_PYTHON_FLAGS, ['-E', '-P']);
  assert.deepEqual(calls, [['/py/python3', '-E', '-P', '-c', 'from mlx_audio.tts.utils import load_model']]);
  const target = join(home, 'voices', 'qwen3');
  assert.deepEqual(readdirSync(target).sort(), ['a.wav', 'b.wav', 'manifest.json']);
  assert.equal(readFileSync(join(target, 'a.wav'), 'utf8'), 'alpha-audio');
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')), {
    schema: 'gentle-speak.qwen-voices/v1', python: '/py/python3', model: QWEN_MODEL_ID,
    voices: Object.fromEntries(Object.entries(catalog).map(([id, v]) => [id, { file: v.file, sha256: v.sha256, bytes: v.bytes, transcript: v.transcript }])),
  });
  const status = await qwenVoicesStatus(home, catalog);
  assert.deepEqual(status, { manifest: 'valid', voices: { 'qwen-a': 'installed', 'qwen-b': 'installed' } });
  await installQwenVoices({ sourceDir: source, home, python: '/py/python3', catalog, run }); // idempotent
  assert.deepEqual((await qwenVoicesStatus(home, catalog)).voices, status.voices);
}));

test('sha mismatch publishes nothing and reports invalid', () => tmp(async dir => {
  const { source, catalog, home } = fixture(dir);
  writeFileSync(join(source, 'b.wav'), Buffer.from('beta-audio??')); // same size, different hash
  await assert.rejects(installQwenVoices({ sourceDir: source, home, python: 'py', catalog, run: okRun().run }), /qwen-b|sha256/);
  const target = join(home, 'voices', 'qwen3');
  assert.equal(existsSync(join(target, 'b.wav')), false);
  assert.equal(existsSync(join(target, 'manifest.json')), false);
  assert.deepEqual(existsSync(target) ? readdirSync(target).filter(n => n.endsWith('.tmp') || n.includes('.tmp')) : [], []);
  const status = await qwenVoicesStatus(home, catalog);
  assert.notEqual(status.voices['qwen-b'], 'installed');
  assert.notEqual(status.manifest, 'valid');
}));

test('failed python check writes no manifest and no files', () => tmp(async dir => {
  const { source, catalog, home } = fixture(dir);
  await assert.rejects(installQwenVoices({ sourceDir: source, home, python: 'py', catalog, run: async () => ({ code: 1 }) }), /mlx_audio|python/i);
  assert.equal(existsSync(join(home, 'voices')), false);
  assert.deepEqual(await qwenVoicesStatus(home, catalog), { manifest: 'missing', voices: { 'qwen-a': 'missing', 'qwen-b': 'missing' } });
}));

test('existing different file is never overwritten and reports invalid', () => tmp(async dir => {
  const { source, catalog, home } = fixture(dir);
  const target = join(home, 'voices', 'qwen3');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'a.wav'), 'user-owned');
  await assert.rejects(installQwenVoices({ sourceDir: source, home, python: 'py', catalog, run: okRun().run }), /a\.wav|invalid/i);
  assert.equal(readFileSync(join(target, 'a.wav'), 'utf8'), 'user-owned');
  assert.equal(existsSync(join(target, 'manifest.json')), false);
  assert.equal((await qwenVoicesStatus(home, catalog)).voices['qwen-a'], 'invalid');
}));
