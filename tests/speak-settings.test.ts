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
  const settings = { ...DEFAULT_SPEAK_SETTINGS, enabled: true, mode: 'summary' as const, voice: 'es_ES', speed: 1.25, shortcuts: { speakLast: 'ctrl+alt+s', stop: 'ctrl+alt+x', toggle: 'ctrl+alt+t', cycleVoice: 'ctrl+alt+b', toggleCopy: 'ctrl+alt+y' } };
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
    assert.equal(new Set(Object.values(parsed.shortcuts)).size, 5);
  }
});

test('an explicit duplicate cycleVoice is still rejected', () => {
  const shortcuts = { speakLast: 'ctrl+alt+n', stop: 'ctrl+alt+.', toggle: 'ctrl+alt+m', cycleVoice: 'ctrl+alt+n' };
  assert.equal(parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, enabled: true, mode: 'all', voice: 'es_MX', speed: 1, summaryModel: null, shortcuts })), undefined);
});

// S8 copySpeech setting.
const realFile = (extra: Record<string, unknown> = {}, cycle = true) => ({ schema: SPEAK_SETTINGS_SCHEMA, enabled: true, mode: 'all', voice: 'es_MX', speed: 1, summaryModel: null,
  shortcuts: { speakLast: 'ctrl+alt+v', stop: 'ctrl+alt+.', toggle: 'ctrl+alt+m', ...(cycle ? { cycleVoice: 'ctrl+alt+n' } : {}) }, ...extra });

test('copySpeech defaults to false and the user real file shape loads unchanged plus copySpeech:false', () => {
  assert.equal(DEFAULT_SPEAK_SETTINGS.copySpeech, false);
  for (const cycle of [true, false]) {
    const parsed = parseSpeakSettingsFile(JSON.stringify(realFile({}, cycle)));
    assert.ok(parsed);
    assert.equal(parsed.copySpeech, false);
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.mode, 'all');
    assert.equal(parsed.voice, 'es_MX');
    assert.equal(parsed.shortcuts.speakLast, 'ctrl+alt+v');
    assert.equal(parsed.shortcuts.stop, 'ctrl+alt+.');
    assert.equal(parsed.shortcuts.toggle, 'ctrl+alt+m');
  }
});

test('copySpeech true loads, round-trips through write, and keeps the schema string', () => withHome(home => {
  assert.equal(parseSpeakSettingsFile(JSON.stringify(realFile({ copySpeech: true })))?.copySpeech, true);
  const path = writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, copySpeech: true }, home);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).schema, 'gentle-speak.settings/v1');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).copySpeech, true);
  assert.equal(readSpeakSettings(home).copySpeech, true);
}));

test('unknown keys and non-boolean copySpeech are rejected', () => {
  for (const extra of [{ extra: 1 }, { copySpeech: 'yes' }, { copySpeech: 1 }, { copySpeech: null }, { copy_speech: true }]) {
    assert.equal(parseSpeakSettingsFile(JSON.stringify(realFile(extra))), undefined, JSON.stringify(extra));
  }
  assert.throws(() => withHome(home => writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, copySpeech: 'x' } as any, home)), /Invalid speak settings/);
});

// T24: rebindable toggleCopy key.
const withShortcuts = (shortcuts: Record<string, unknown>) => JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, enabled: true, mode: 'all', voice: 'es_MX', speed: 1, summaryModel: null, shortcuts });
const four = { speakLast: 'ctrl+alt+v', stop: 'ctrl+alt+.', toggle: 'ctrl+alt+m', cycleVoice: 'ctrl+alt+n' };

test('toggleCopy defaults to ctrl+alt+c; files without it (with or without cycleVoice) load filled with the default', () => {
  assert.equal(DEFAULT_SPEAK_SETTINGS.shortcuts.toggleCopy, 'ctrl+alt+c');
  const withCycle = parseSpeakSettingsFile(withShortcuts(four));
  assert.deepEqual(withCycle?.shortcuts, { ...four, toggleCopy: 'ctrl+alt+c' });
  const v1 = parseSpeakSettingsFile(withShortcuts({ speakLast: 'ctrl+alt+v', stop: 'ctrl+alt+.', toggle: 'ctrl+alt+m' }));
  assert.deepEqual(v1?.shortcuts, { ...four, toggleCopy: 'ctrl+alt+c' });
  assert.equal(parseSpeakSettingsFile(withShortcuts({ ...four, toggleCopy: 'ctrl+alt+q' }))?.shortcuts.toggleCopy, 'ctrl+alt+q');
});

test('an older file that already binds ctrl+alt+c keeps loading; the missing toggleCopy takes a free default', () => {
  for (const key of ['speakLast', 'stop', 'toggle', 'cycleVoice']) {
    const parsed = parseSpeakSettingsFile(withShortcuts({ ...four, [key]: 'ctrl+alt+c' }));
    assert.ok(parsed, `${key}=ctrl+alt+c must still load`);
    assert.equal(parsed.shortcuts[key as 'stop'], 'ctrl+alt+c');
    assert.notEqual(parsed.shortcuts.toggleCopy, 'ctrl+alt+c');
    assert.equal(new Set(Object.values(parsed.shortcuts)).size, 5);
  }
});

test('reserved, duplicate and malformed toggleCopy are rejected on parse and write, leaving the file unchanged', () => withHome(home => {
  for (const toggleCopy of ['ctrl+k', 'ctrl+p', 'alt+k', 'alt+a', four.speakLast, four.stop, four.toggle, four.cycleVoice, 'c', 'ctrl+alt+', 7, null]) {
    assert.equal(parseSpeakSettingsFile(withShortcuts({ ...four, toggleCopy })), undefined, String(toggleCopy));
  }
  const path = writeSpeakSettings(DEFAULT_SPEAK_SETTINGS, home);
  const before = readFileSync(path, 'utf8');
  for (const toggleCopy of ['ctrl+k', 'ctrl+alt+m', 'bad']) {
    assert.throws(() => writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, shortcuts: { ...DEFAULT_SPEAK_SETTINGS.shortcuts, toggleCopy } }, home), /Invalid speak settings/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.deepEqual(readdirSync(home), ['speak-settings.json']);
  }
}));

// S11: macVoice / macFallback
test('macVoice defaults to null (auto) and macFallback to true; old files without them still load', () => withHome(home => {
  assert.equal(DEFAULT_SPEAK_SETTINGS.macVoice, null);
  assert.equal(DEFAULT_SPEAK_SETTINGS.macFallback, true);
  const { macVoice: _a, macFallback: _b, ...old } = DEFAULT_SPEAK_SETTINGS;
  const raw = JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...old, enabled: true });
  writeFileSync(join(home, 'speak-settings.json'), raw);
  const loaded = readSpeakSettings(home);
  assert.equal(loaded.enabled, true);
  assert.equal(loaded.macVoice, null);
  assert.equal(loaded.macFallback, true);
}));

test('valid macVoice and macFallback persist and round-trip', () => withHome(home => {
  for (const name of ['Paulina', 'Eddy (Español (México))', "O'Brien-2 x.y_z", 'a'.repeat(64)]) {
    writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, macVoice: name, macFallback: false }, home);
    const loaded = readSpeakSettings(home);
    assert.equal(loaded.macVoice, name);
    assert.equal(loaded.macFallback, false);
  }
}));

test('invalid macVoice or macFallback rejects the file and leaves stored data unchanged', () => withHome(home => {
  const path = writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, macVoice: 'Paulina' }, home);
  const before = readFileSync(path, 'utf8');
  for (const bad of ['', 'a'.repeat(65), 'Bad/Name', 'rm -rf; x', 'x\ny', 7, true, ['Paulina'], {}]) {
    assert.throws(() => writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, macVoice: bad as any }, home), /Invalid speak settings/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, macVoice: bad })), undefined);
  }
  for (const bad of ['true', 1, null, 'yes']) {
    assert.throws(() => writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, macFallback: bad as any }, home), /Invalid speak settings/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(parseSpeakSettingsFile(JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, macFallback: bad })), undefined);
  }
  assert.deepEqual(readdirSync(home), ['speak-settings.json']);
}));

test('mac is a valid voice id in settings', () => withHome(home => {
  writeSpeakSettings({ ...DEFAULT_SPEAK_SETTINGS, voice: 'mac' }, home);
  assert.equal(readSpeakSettings(home).voice, 'mac');
}));
