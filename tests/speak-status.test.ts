import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VOICE_CATALOG } from '../lib/speak-voices.ts';
import { DEFAULT_SPEAK_SETTINGS } from '../lib/speak-settings.ts';
import { SPEAK_STATUS_KEY, formatSpeakStatus, nextAvailableVoice, voiceMenuEntries } from '../lib/speak-status.ts';

const order = Object.keys(VOICE_CATALOG);
const keys = DEFAULT_SPEAK_SETTINGS.shortcuts;

test('status row shows title, state, voice label and configured keys; both states', () => {
  assert.equal(SPEAK_STATUS_KEY, 'gentle-speak');
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', copySpeech: false, shortcuts: keys }), 'SPEAK ● on · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c');
  assert.equal(formatSpeakStatus({ enabled: false, voiceLabel: 'Brisa', copySpeech: false, shortcuts: keys }), 'SPEAK ○ off · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c');
  assert.match(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', copySpeech: false, shortcuts: { ...keys, toggle: 'ctrl+alt+x', cycleVoice: 'ctrl+alt+y', toggleCopy: 'ctrl+alt+z' } }), /ctrl\+alt\+x on\/off · ctrl\+alt\+y voz/);
});

test('status row survives the Gentle Shell sanitizer unchanged and keeps the state in the first 44 columns', () => {
  // Mirrors gentle-pi lib/shell-bar.ts sanitizeStatus: strip control chars, collapse spaces, trim.
  const sanitize = (text: string) => text.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/ +/g, ' ').trim();
  for (const enabled of [true, false]) {
    const row = formatSpeakStatus({ enabled, voiceLabel: 'Español (México)', copySpeech: false, shortcuts: keys });
    assert.equal(sanitize(row), row);
    assert.ok(row.slice(0, 44).includes(enabled ? '● on' : '○ off'));
  }
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Bad\u001b[31m\nLabel\u0007', copySpeech: false, shortcuts: keys }).includes('\u001b'), false);
});

test('cycling advances to the next available voice in catalog order and wraps', () => {
  const all = Object.fromEntries(order.map(id => [id, true]));
  assert.equal(nextAvailableVoice(order, 'es_MX', all), 'es_ES');
  assert.equal(nextAvailableVoice(order, 'qwen-viva', all), 'mac');
  assert.equal(nextAvailableVoice(order, 'mac', all), 'es_MX');
  const sparse = { es_MX: true, es_ES: false, 'qwen-brisa': true, 'qwen-viva': true };
  assert.equal(nextAvailableVoice(order, 'es_MX', sparse), 'qwen-brisa');
  assert.equal(nextAvailableVoice(order, 'qwen-brisa', sparse), 'qwen-viva');
  assert.equal(nextAvailableVoice(order, 'qwen-viva', sparse), 'es_MX');
  assert.equal(nextAvailableVoice(order, 'es_ES', sparse), 'qwen-brisa');
});

test('cycling with no other available voice returns undefined', () => {
  assert.equal(nextAvailableVoice(order, 'es_MX', { es_MX: true }), undefined);
  assert.equal(nextAvailableVoice(order, 'es_MX', {}), undefined);
});

test('voice menu entries follow catalog order with label, id and installed state', () => {
  const entries = voiceMenuEntries(VOICE_CATALOG, { es_MX: true, 'qwen-brisa': true });
  assert.deepEqual(entries.map(entry => entry.id), order);
  assert.equal(entries.length, 10);
  assert.equal(entries[9].text, 'Voice: Mac (mac) — not installed');
  assert.equal(entries[0].text, 'Voice: Español (México) (es_MX) — installed');
  assert.equal(entries[1].text, 'Voice: Español (España) (es_ES) — not installed');
  assert.ok(entries.every(entry => entry.text.includes(`(${entry.id})`)));
});

test('status row shows the active mode right after the on/off state', () => {
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', mode: 'all', copySpeech: false, shortcuts: keys }), 'SPEAK ● on · modo todo · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c');
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', mode: 'questions-and-results', copySpeech: false, shortcuts: keys }), 'SPEAK ● on · modo preguntas y resultados · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c');
  assert.equal(formatSpeakStatus({ enabled: false, voiceLabel: 'Brisa', mode: 'summary', summaryReady: true, copySpeech: false, shortcuts: keys }), 'SPEAK ○ off · modo resumen · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c');
  // Summary without a configured model never speaks, so the row says so.
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', mode: 'summary', summaryReady: false, copySpeech: false, shortcuts: keys }), 'SPEAK ● on · modo resumen sin modelo · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c');
});

test('status row always shows the copy state with its key: on/off speech x on/off copy, plus sin modelo', () => {
  const row = (enabled: boolean, copySpeech: boolean, extra: object = {}) => formatSpeakStatus({ enabled, voiceLabel: 'Íntima', mode: 'all', copySpeech, shortcuts: keys, ...extra });
  assert.equal(row(true, false), 'SPEAK ● on · modo todo · Íntima · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c');
  assert.equal(row(true, true), 'SPEAK ● on · modo todo · Íntima · ctrl+alt+m on/off · ctrl+alt+n voz · copia ● ctrl+alt+c');
  assert.equal(row(false, false), 'SPEAK ○ off · modo todo · Íntima · ctrl+alt+m on/off · ctrl+alt+n voz · copia ○ ctrl+alt+c');
  assert.equal(row(false, true), 'SPEAK ○ off · modo todo · Íntima · ctrl+alt+m on/off · ctrl+alt+n voz · copia ● ctrl+alt+c');
  assert.equal(row(true, true, { mode: 'summary', summaryReady: false }), 'SPEAK ● on · modo resumen sin modelo · Íntima · ctrl+alt+m on/off · ctrl+alt+n voz · copia ● ctrl+alt+c');
  assert.equal(row(true, false, { shortcuts: { ...keys, toggleCopy: 'ctrl+alt+y' } }).endsWith('· copia ○ ctrl+alt+y'), true);
  const sanitize = (text: string) => text.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/ +/g, ' ').trim();
  for (const copy of [true, false]) assert.equal(sanitize(row(true, copy)), row(true, copy));
});

// S11
test('cycleVoice with say available includes mac exactly once; without it mac is skipped', () => {
  const order = Object.keys(VOICE_CATALOG);
  const withSay = Object.fromEntries(order.map(id => [id, true]));
  const seen: string[] = [];
  let current = 'es_MX';
  for (let i = 0; i < order.length; i++) { current = nextAvailableVoice(order, current, withSay)!; seen.push(current); }
  assert.equal(seen.filter(id => id === 'mac').length, 1);
  assert.equal(new Set(seen).size, order.length);
  const noSay = { ...withSay, mac: false };
  current = 'es_MX'; const seen2: string[] = [];
  for (let i = 0; i < order.length; i++) { current = nextAvailableVoice(order, current, noSay)!; seen2.push(current); }
  assert.equal(seen2.includes('mac'), false);
});

test('row shows the Mac voice name next to the label', () => {
  const keys = DEFAULT_SPEAK_SETTINGS.shortcuts;
  assert.match(formatSpeakStatus({ enabled: true, voiceLabel: 'Mac · Paulina', copySpeech: false, shortcuts: keys }), /^SPEAK ● on · Mac · Paulina · ctrl\+alt\+m on\/off/);
});
