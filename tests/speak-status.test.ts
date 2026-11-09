import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VOICE_CATALOG } from '../lib/speak-voices.ts';
import { DEFAULT_SPEAK_SETTINGS } from '../lib/speak-settings.ts';
import { SPEAK_STATUS_KEY, formatSpeakStatus, nextAvailableVoice, voiceMenuEntries } from '../lib/speak-status.ts';

const order = Object.keys(VOICE_CATALOG);
const keys = DEFAULT_SPEAK_SETTINGS.shortcuts;

test('status row shows title, state, voice label and configured keys; both states', () => {
  assert.equal(SPEAK_STATUS_KEY, 'gentle-speak');
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', shortcuts: keys }), 'SPEAK ● on · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz');
  assert.equal(formatSpeakStatus({ enabled: false, voiceLabel: 'Brisa', shortcuts: keys }), 'SPEAK ○ off · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz');
  assert.match(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', shortcuts: { ...keys, toggle: 'ctrl+alt+x', cycleVoice: 'ctrl+alt+y' } }), /ctrl\+alt\+x on\/off · ctrl\+alt\+y voz/);
});

test('status row survives the Gentle Shell sanitizer unchanged and keeps the state in the first 44 columns', () => {
  // Mirrors gentle-pi lib/shell-bar.ts sanitizeStatus: strip control chars, collapse spaces, trim.
  const sanitize = (text: string) => text.replace(/[\r\n\t]/g, ' ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/ +/g, ' ').trim();
  for (const enabled of [true, false]) {
    const row = formatSpeakStatus({ enabled, voiceLabel: 'Español (México)', shortcuts: keys });
    assert.equal(sanitize(row), row);
    assert.ok(row.slice(0, 44).includes(enabled ? '● on' : '○ off'));
  }
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Bad\u001b[31m\nLabel\u0007', shortcuts: keys }).includes('\u001b'), false);
});

test('cycling advances to the next available voice in catalog order and wraps', () => {
  const all = Object.fromEntries(order.map(id => [id, true]));
  assert.equal(nextAvailableVoice(order, 'es_MX', all), 'es_ES');
  assert.equal(nextAvailableVoice(order, 'qwen-viva', all), 'es_MX');
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
  assert.equal(entries.length, 9);
  assert.equal(entries[0].text, 'Voice: Español (México) (es_MX) — installed');
  assert.equal(entries[1].text, 'Voice: Español (España) (es_ES) — not installed');
  assert.ok(entries.every(entry => entry.text.includes(`(${entry.id})`)));
});

test('status row shows the active mode right after the on/off state', () => {
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', mode: 'all', shortcuts: keys }), 'SPEAK ● on · modo todo · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz');
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', mode: 'questions-and-results', shortcuts: keys }), 'SPEAK ● on · modo preguntas y resultados · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz');
  assert.equal(formatSpeakStatus({ enabled: false, voiceLabel: 'Brisa', mode: 'summary', summaryReady: true, shortcuts: keys }), 'SPEAK ○ off · modo resumen · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz');
  // Summary without a configured model never speaks, so the row says so.
  assert.equal(formatSpeakStatus({ enabled: true, voiceLabel: 'Brisa', mode: 'summary', summaryReady: false, shortcuts: keys }), 'SPEAK ● on · modo resumen sin modelo · Brisa · ctrl+alt+m on/off · ctrl+alt+n voz');
});
