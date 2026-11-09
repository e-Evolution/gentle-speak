import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterSettledSpeech } from '../lib/speak-filter.ts';

const assistant = (text: string, stopReason = 'stop') => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }] });
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

test('default reads final questions and usable results, not intermediate or user content', () => {
  assert.equal(filterSettledSpeech([user('Secret?'), assistant('Thinking aloud?', 'toolUse'), assistant('¿Quieres que continúe?')]), '¿Quieres que continúe?');
  assert.equal(filterSettledSpeech([assistant('Listo: el archivo quedó actualizado.')]), 'Listo: el archivo quedó actualizado.');
  assert.equal(filterSettledSpeech([assistant('Estoy pensando en el siguiente paso.')]), undefined);
  assert.equal(filterSettledSpeech([assistant('¿Una pregunta?', 'toolUse')]), undefined);
  assert.equal(filterSettledSpeech([assistant('¿Una pregunta?'), user('next')]), undefined);
});

test('all reads prose but never code, diffs, or tool output', () => {
  assert.equal(filterSettledSpeech([assistant('Hola `token`.\n```ts\nconst secret = 1\n```\nResultado disponible.\n```diff\n-old\n+new\n```\n+ leaked\n@@ -1 +1 @@')], 'all'), 'Hola. Resultado disponible.');
  assert.equal(filterSettledSpeech([assistant('```\nonly code\n```')], 'all'), undefined);
  assert.equal(filterSettledSpeech([assistant('- Una respuesta útil.\n+ leaked\n@@ -1 +1 @@')], 'all'), 'Una respuesta útil.');
  assert.equal(filterSettledSpeech([{ role: 'toolResult', content: [{ type: 'text', text: 'Tool secret' }] }], 'all'), undefined);
  assert.equal(filterSettledSpeech([{ role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall', text: 'secret' }] }], 'all'), undefined);
});

test('default speaks declarative answers without result keywords and keeps Markdown bullets', () => {
  assert.equal(filterSettledSpeech([assistant('La capital de Francia es París.')]), 'La capital de Francia es París.');
  assert.equal(filterSettledSpeech([assistant('- La capital de Francia es París.\n- Su moneda es el euro.')]), 'La capital de Francia es París. Su moneda es el euro.');
  assert.equal(filterSettledSpeech([assistant('Estoy revisando los archivos.')]), undefined);
  assert.equal(filterSettledSpeech([assistant('La capital de Francia es París.', 'toolUse')]), undefined);
  assert.equal(filterSettledSpeech([{ role: 'toolResult', content: [{ type: 'text', text: 'La capital de Francia es París.' }] }]), undefined);
});

test('summary does not invent a sentence; generation belongs to integration', () => {
  assert.equal(filterSettledSpeech([assistant('¿Continuamos?')], 'summary'), undefined);
});

test('rejects unfinished, errored, or non-text assistant output', () => {
  assert.equal(filterSettledSpeech([assistant('¿Continuamos?', 'error')], 'all'), undefined);
  assert.equal(filterSettledSpeech([{ role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'private' }] }], 'all'), undefined);
});

test('speaks only on the stop reason pi-ai emits for a finished answer', () => {
  // pi-ai StopReason is "stop" | "length" | "toolUse" | "error" | "aborted" | ...; it never emits "end_turn".
  assert.equal(filterSettledSpeech([assistant('Resultado listo.', 'stop')], 'all'), 'Resultado listo.');
  for (const reason of ['toolUse', 'length', 'error', 'aborted', 'end_turn']) {
    assert.equal(filterSettledSpeech([assistant('Resultado listo.', reason)], 'all'), undefined, reason);
  }
});

test('drops markdown emphasis markers and brackets left empty by removed inline code', () => {
  assert.equal(filterSettledSpeech([assistant('Corrí la suite: **151/151**, *todo* verde (`npm test`).')], 'all'), 'Corrí la suite: 151/151, todo verde.');
  assert.equal(filterSettledSpeech([assistant('Tu configuración actual** (`settings.json`): __on__ [`x`].')], 'all'), 'Tu configuración actual: on.');
});
