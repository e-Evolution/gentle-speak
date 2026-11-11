import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, VOICE_CATALOG, parseSpeakSettingsFile, readSpeakSettings, writeSpeakSettings } from '../lib/speak-settings.ts';
import { QWEN_MODEL_ID, QWEN_PYTHON_FLAGS } from '../lib/speak-voices.ts';
import { LEGACY_QWEN_VOICES } from '../lib/speak-voices-install.ts';

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

test('T45: the migration table keeps the seven old voices with exact files, transcripts and hashes; the public catalog is Piper and mac only', () => {
  assert.deepEqual(Object.keys(LEGACY_QWEN_VOICES).sort(), Object.keys(EXPECTED).sort());
  for (const [id, voice] of Object.entries(LEGACY_QWEN_VOICES)) {
    const [label, file, transcript, hash, bytes] = EXPECTED[id];
    assert.deepEqual({ ...voice }, { name: id.slice('qwen-'.length), label, file, transcript, sha256: hash, bytes });
  }
  assert.deepEqual(Object.keys(VOICE_CATALOG), ['es_MX', 'es_ES', 'mac']);
  assert.deepEqual({ ...VOICE_CATALOG.es_MX }, { engine: 'piper', locale: 'es_MX', language: 'es', label: 'Español (México)' });
  assert.deepEqual({ ...VOICE_CATALOG.es_ES }, { engine: 'piper', locale: 'es_ES', language: 'es', label: 'Español (España)' });
  assert.deepEqual({ ...VOICE_CATALOG.mac }, { engine: 'system', label: 'Mac' });
  assert.equal(QWEN_MODEL_ID, 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16');
  assert.deepEqual(QWEN_PYTHON_FLAGS, ['-E', '-P']);
});

test('settings accept every catalog voice and round-trip a custom voice; default stays es_MX', () => tmp(home => {
  assert.equal(DEFAULT_SPEAK_SETTINGS.voice, 'es_MX');
  for (const voice of Object.keys(VOICE_CATALOG)) {
    const settings = { ...DEFAULT_SPEAK_SETTINGS, voice };
    writeSpeakSettings(settings, home);
    assert.deepEqual(readSpeakSettings(home), settings);
  }
  const custom = { ...DEFAULT_SPEAK_SETTINGS, voice: 'custom:mi-voz' };
  writeSpeakSettings(custom, home);
  assert.deepEqual(readSpeakSettings(home), custom);
}));

test('v1 file without cycleVoice loads unchanged plus the default; cycleVoice is ctrl+alt+n', () => {
  assert.equal(DEFAULT_SPEAK_SETTINGS.shortcuts.cycleVoice, 'ctrl+alt+n');
  const shortcuts = { speakLast: 'ctrl+alt+s', stop: 'ctrl+alt+x', toggle: 'ctrl+alt+t' };
  const v1 = { schema: SPEAK_SETTINGS_SCHEMA, enabled: true, mode: 'summary', voice: 'es_ES', speed: 1.25, shortcuts };
  assert.deepEqual(parseSpeakSettingsFile(JSON.stringify(v1)), { enabled: true, mode: 'summary', voice: 'es_ES', speed: 1.25, summaryModel: null, copySpeech: false, macVoice: null, macFallback: true, dotSpeech: false, dotOffer: null, qwenIdleMinutes: 10, shortcuts: { ...shortcuts, cycleVoice: 'ctrl+alt+n', toggleCopy: 'ctrl+alt+c' } });
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
