import './helpers/guard-real-home.ts';
// T42 / S14: custom voices library: listing + validation, atomic create/delete, catalog entries, WAV inspection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VOICE_CATALOG } from '../lib/speak-voices.ts';
import { createCustomVoice, customCatalog, deleteCustomVoice, inspectWav, listCustomVoices, readCustomVoice, slugifyVoiceId } from '../lib/speak-custom-voices.ts';
import { makeWav, sha256, tempHome, writeEntry } from './helpers/custom-voice-fixture.ts';

const base = (home: string, over: Record<string, unknown> = {}) => ({ home, id: 'mi-voz', label: 'Mi voz', transcript: 'Hola, esta es mi voz.', source: 'designed' as const, language: 'es', description: 'cálida y cercana', wav: makeWav(4), ...over });

// ---- listing and validation ----
test('lists valid entries sorted by id; a missing custom dir is an empty list', async () => {
  const t = tempHome();
  try {
    assert.deepEqual(await listCustomVoices(t.home), { voices: [], skipped: [] });
    writeEntry(t.custom, 'zeta', { meta: { label: 'Zeta' } }); writeEntry(t.custom, 'alfa', { meta: { label: 'Alfa', source: 'recorded' } });
    const { voices, skipped } = await listCustomVoices(t.home);
    assert.deepEqual(voices.map(v => v.id), ['custom:alfa', 'custom:zeta']);
    assert.deepEqual(skipped, []);
    assert.deepEqual({ ...voices[0] }, { id: 'custom:alfa', engine: 'qwen3', custom: true, label: 'Propia · Alfa', ref: join(t.custom, 'alfa', 'reference.wav'), transcript: 'Hola, esta es mi voz.', source: 'recorded' });
  } finally { t.close(); }
});

test('invalid entries are skipped with a reason: sha256 mismatch, bad label/transcript/source/id, missing files, id mismatch, symlinked wav', async () => {
  const t = tempHome();
  try {
    writeEntry(t.custom, 'ok');
    writeEntry(t.custom, 'tampered', { meta: { sha256: 'f'.repeat(64) } });
    writeEntry(t.custom, 'longlabel', { meta: { label: 'x'.repeat(41) } });
    writeEntry(t.custom, 'nolabel', { meta: { label: '' } });
    writeEntry(t.custom, 'notext', { meta: { transcript: '' } });
    writeEntry(t.custom, 'bigtext', { meta: { transcript: 'a'.repeat(501) } });
    writeEntry(t.custom, 'badsource', { meta: { source: 'cloned' } });
    writeEntry(t.custom, 'wrongid', { meta: { id: 'other' } });
    writeEntry(t.custom, 'nowav', { wav: null });
    writeEntry(t.custom, 'badjson', { voiceJson: '{nope' });
    writeEntry(t.custom, 'Upper');
    writeEntry(t.custom, 'linked'); // wav replaced below by a symlink
    writeEntry(t.custom, 'target');
    const link = join(t.custom, 'linked', 'reference.wav');
    writeFileSync(join(t.custom, 'linked', 'x'), ''); (await import('node:fs')).rmSync(link); symlinkSync(join(t.custom, 'target', 'reference.wav'), link);
    mkdirSync(join(t.custom, '.stage-123')); // a half-written stage dir is ignored, not reported
    const { voices, skipped } = await listCustomVoices(t.home);
    assert.deepEqual(voices.map(v => v.id), ['custom:ok', 'custom:target']);
    assert.deepEqual(skipped.map(s => s.id).sort(), ['Upper', 'badjson', 'badsource', 'bigtext', 'linked', 'longlabel', 'nolabel', 'notext', 'nowav', 'tampered', 'wrongid']);
    assert.equal(skipped.find(s => s.id === 'tampered')!.reason, 'sha256 mismatch');
    assert.equal(await readCustomVoice(t.home, 'tampered'), undefined);
    assert.equal((await readCustomVoice(t.home, 'ok'))?.id, 'custom:ok');
  } finally { t.close(); }
});

// ---- atomic create ----
test('create writes voice.json (all fields, sha256 of the wav) and reference.wav, leaves no stage dir, and lists', async () => {
  const t = tempHome();
  try {
    const wav = makeWav(5);
    const voice = await createCustomVoice(base(t.home, { wav, now: new Date('2026-11-11T10:00:00Z') }));
    assert.equal(voice.id, 'custom:mi-voz');
    assert.deepEqual(readdirSync(t.custom), ['mi-voz']);
    assert.deepEqual(readdirSync(join(t.custom, 'mi-voz')).sort(), ['reference.wav', 'voice.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(t.custom, 'mi-voz', 'voice.json'), 'utf8')), { id: 'mi-voz', label: 'Mi voz', transcript: 'Hola, esta es mi voz.', description: 'cálida y cercana', language: 'es', source: 'designed', created: '2026-11-11T10:00:00.000Z', sha256: sha256(wav) });
    assert.equal(sha256(readFileSync(join(t.custom, 'mi-voz', 'reference.wav'))), sha256(wav));
    assert.deepEqual((await listCustomVoices(t.home)).voices.map(v => v.id), ['custom:mi-voz']);
  } finally { t.close(); }
});

test('create is all-or-nothing: invalid input or WAV leaves nothing behind, and an existing id is refused unchanged', async () => {
  const t = tempHome();
  try {
    const bad: Array<[string, Record<string, unknown>, RegExp]> = [
      ['id', { id: 'Bad_ID' }, /id/], ['traversal', { id: '../x' }, /id/], ['long id', { id: 'a'.repeat(33) }, /id/],
      ['label', { label: 'x'.repeat(41) }, /label/], ['empty label', { label: '  ' }, /label/], ['transcript', { transcript: '' }, /transcript/], ['transcript long', { transcript: 'a'.repeat(501) }, /transcript/],
      ['source', { source: 'cloned' }, /source/], ['not wav', { wav: Buffer.from('not a wav') }, /wav/i], ['too short', { wav: makeWav(1) }, /short/], ['too long', { wav: makeWav(31) }, /long/], ['stereo', { wav: makeWav(4, { channels: 2 }) }, /mono/],
    ];
    for (const [name, over, re] of bad) await assert.rejects(createCustomVoice(base(t.home, over) as any), re, name);
    assert.equal(existsSync(t.custom) ? readdirSync(t.custom).length : 0, 0, 'nothing left behind, not even a stage dir');
    await createCustomVoice(base(t.home));
    const before = readFileSync(join(t.custom, 'mi-voz', 'voice.json'), 'utf8');
    await assert.rejects(createCustomVoice(base(t.home, { label: 'Otra', wav: makeWav(6) })), /exists/);
    assert.equal(readFileSync(join(t.custom, 'mi-voz', 'voice.json'), 'utf8'), before);
    assert.deepEqual(readdirSync(t.custom), ['mi-voz']);
  } finally { t.close(); }
});

// ---- delete ----
test('delete removes the entry; unknown ids return false; an invalid id never touches anything; a symlinked entry loses only the link', async () => {
  const t = tempHome();
  try {
    await createCustomVoice(base(t.home)); await createCustomVoice(base(t.home, { id: 'otra' }));
    assert.equal(await deleteCustomVoice(t.home, 'mi-voz'), true);
    assert.deepEqual(readdirSync(t.custom), ['otra']);
    assert.equal(await deleteCustomVoice(t.home, 'mi-voz'), false);
    writeFileSync(join(t.root, 'precious.txt'), 'keep');
    for (const id of ['../../precious.txt', '..', '', 'A', 'a/b']) await assert.rejects(deleteCustomVoice(t.home, id), /id/);
    assert.equal(readFileSync(join(t.root, 'precious.txt'), 'utf8'), 'keep');
    const outside = join(t.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'reference.wav'), 'x');
    symlinkSync(outside, join(t.custom, 'linkvoice'));
    assert.equal(await deleteCustomVoice(t.home, 'linkvoice'), true);
    assert.equal(existsSync(join(outside, 'reference.wav')), true, 'the link target is never deleted');
    assert.equal(existsSync(join(t.custom, 'linkvoice')), false);
    assert.deepEqual(readdirSync(t.custom), ['otra']);
  } finally { t.close(); }
});

// ---- catalog merge ----
test('customCatalog yields one qwen3 entry per voice keyed custom:<id>, and merging keeps every built-in untouched', async () => {
  const t = tempHome();
  try {
    await createCustomVoice(base(t.home));
    const catalog = customCatalog((await listCustomVoices(t.home)).voices);
    assert.deepEqual(Object.keys(catalog), ['custom:mi-voz']);
    assert.equal(catalog['custom:mi-voz'].label, 'Propia · Mi voz');
    assert.equal(catalog['custom:mi-voz'].engine, 'qwen3');
    assert.equal(catalog['custom:mi-voz'].ref, join(t.custom, 'mi-voz', 'reference.wav'));
    assert.equal(catalog['custom:mi-voz'].transcript, 'Hola, esta es mi voz.');
    const merged = { ...VOICE_CATALOG, ...catalog };
    assert.deepEqual(Object.keys(merged), [...Object.keys(VOICE_CATALOG), 'custom:mi-voz']);
    assert.equal(Object.keys(VOICE_CATALOG).length, 3, 'Piper es_MX, es_ES and mac: no built-in Qwen voice (T45)');
    assert.equal(Object.keys(VOICE_CATALOG).some(id => id.startsWith('custom:')), false);
  } finally { t.close(); }
});

test('slugifyVoiceId makes a valid unique id from a label', () => {
  assert.equal(slugifyVoiceId('Mi Voz Cálida', new Set()), 'mi-voz-calida');
  assert.equal(slugifyVoiceId('Mi Voz Cálida', new Set(['mi-voz-calida'])), 'mi-voz-calida-2');
  assert.equal(slugifyVoiceId('¡¡¡', new Set()), 'voz');
  assert.match(slugifyVoiceId('x'.repeat(80), new Set(['x'.repeat(32)])), /^[a-z0-9][a-z0-9-]{0,31}$/);
  assert.equal(slugifyVoiceId('x'.repeat(80), new Set(['x'.repeat(32)])).length <= 32, true);
});

// ---- WAV inspection ----
test('inspectWav accepts PCM16 mono 3-30 s and reports why anything else is rejected', () => {
  assert.deepEqual({ ...inspectWav(makeWav(3)) }, { channels: 1, rate: 24000, bits: 16, seconds: 3 });
  assert.equal(inspectWav(makeWav(30)).seconds, 30);
  assert.throws(() => inspectWav(makeWav(2.9)), /short/); assert.throws(() => inspectWav(makeWav(30.1)), /long/);
  assert.throws(() => inspectWav(Buffer.from('RIFFxxxxWAVEjunk')), /wav/i); assert.throws(() => inspectWav(Buffer.alloc(10)), /wav/i);
  assert.throws(() => inspectWav(makeWav(4, { bits: 8 })), /16/); assert.throws(() => inspectWav(makeWav(4, { format: 3, bits: 32 })), /PCM/);
});
