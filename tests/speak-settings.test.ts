import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA, VOICE_CATALOG, parseSpeakSettingsFile, readSpeakSettings, writeSpeakSettings } from '../lib/speak-settings.ts';

const withHome = (run: (home: string) => void) => {
  const home = mkdtempSync(join(tmpdir(), 'gentle-speak-settings-'));
  try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
};

test('missing and malformed settings remain off with default mode and Mexican Spanish voice', () => withHome(home => {
  assert.deepEqual(readSpeakSettings(home), DEFAULT_SPEAK_SETTINGS);
  for (const raw of ['{', '{}', JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, enabled: true }), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, speed: 0 })]) {
    writeFileSync(join(home, 'speak-settings.json'), raw);
    assert.deepEqual(readSpeakSettings(home), DEFAULT_SPEAK_SETTINGS);
    assert.equal(parseSpeakSettingsFile(raw), undefined);
  }
  assert.equal(DEFAULT_SPEAK_SETTINGS.enabled, false);
  assert.equal(DEFAULT_SPEAK_SETTINGS.mode, 'questions-and-results');
  assert.equal(DEFAULT_SPEAK_SETTINGS.voice, 'es_MX');
}));

test('legacy settings without summaryModel migrate to no model; malformed model fails closed', () => withHome(home => {
  const legacy = { schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS };
  const path = join(home, 'speak-settings.json');
  writeFileSync(path, JSON.stringify(legacy));
  assert.deepEqual(readSpeakSettings(home), { ...DEFAULT_SPEAK_SETTINGS, summaryModel: null });
  for (const invalid of [{ provider: '', id: 'x' }, { provider: 'a', id: '../bad' }, { provider: 'a', id: 'x', secret: 'no' }]) {
    assert.throws(() => writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, summaryModel: invalid } as any, home), /Invalid speak settings/);
    assert.deepEqual(readSpeakSettings(home), { ...DEFAULT_SPEAK_SETTINGS, summaryModel: null });
  }
  writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, summaryModel: { provider: 'openai', id: 'gpt-5.2' } }, home);
  assert.deepEqual(readSpeakSettings(home).summaryModel, { provider: 'openai', id: 'gpt-5.2' });
}));

test('catalog contains Spanish locales and permits additional languages without changing settings schema', () => {
  assert.equal(VOICE_CATALOG.es_MX.language, 'es');
  assert.equal(VOICE_CATALOG.es_ES.language, 'es');
  assert.equal(VOICE_CATALOG.es_ES.locale, 'es_ES');
});

test('validated settings persist atomically and reject invalid input without changing existing data', () => withHome(home => {
  const settings = { ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'summary' as const, voice: 'es_ES', speed: 1.25, shortcuts: { speakLast: 'ctrl+alt+s', stop: 'ctrl+alt+x', toggle: 'ctrl+alt+t', cycleVoice: 'ctrl+alt+b' } };
  const path = writeSpeakSettings(settings, home);
  assert.equal(path, join(home, 'speak-settings.json'));
  assert.deepEqual(readSpeakSettings(home), settings);
  assert.deepEqual(parseSpeakSettingsFile(readFileSync(path, 'utf8')), settings);
  assert.deepEqual(readdirSync(home), ['speak-settings.json']);
  const before = readFileSync(path, 'utf8');
  for (const invalid of [{ ...settings, voice: 'unknown' }, { ...settings, speed: Infinity }, { ...settings, shortcuts: { ...settings.shortcuts, stop: settings.shortcuts.speakLast } }, { ...settings, shortcuts: { ...settings.shortcuts, toggle: 'ctrl+k' } }]) {
    assert.throws(() => writeSpeakSettings(invalid, home), /Invalid speak settings/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(readdirSync(home), ['speak-settings.json']);
  }
}));

test('v1 files that bind ctrl+alt+n to another action stay valid', () => {
  for (const key of ['speakLast', 'stop', 'toggle']) {
    const shortcuts: Record<string, string> = { speakLast: 'ctrl+alt+v', stop: 'ctrl+alt+.', toggle: 'ctrl+alt+m', [key]: 'ctrl+alt+n' };
    const parsed = parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, enabled: true, mode: 'all', voice: 'es_MX', speed: 1, summaryModel: null, shortcuts }));
    assert.ok(parsed, `${key}=ctrl+alt+n must still load`);
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.shortcuts[key as 'stop'], 'ctrl+alt+n');
    assert.notEqual(parsed.shortcuts.cycleVoice, 'ctrl+alt+n');
    assert.equal(new Set(Object.values(parsed.shortcuts)).size, 4);
  }
});

test('an explicit duplicate cycleVoice is still rejected', () => {
  const shortcuts = { speakLast: 'ctrl+alt+n', stop: 'ctrl+alt+.', toggle: 'ctrl+alt+m', cycleVoice: 'ctrl+alt+n' };
  assert.equal(parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, enabled: true, mode: 'all', voice: 'es_MX', speed: 1, summaryModel: null, shortcuts })), undefined);
});
