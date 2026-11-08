import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterSettledSpeech } from '../lib/speak-filter.ts';

const assistant = (text: string, stopReason = 'end_turn') => ({ role: 'assistant', stopReason, content: [{ type: 'text', text }] });
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

test('default reads final questions and usable results, not intermediate or user content', () => {
  assert.equal(filterSettledSpeech([user('Secret?'), assistant('Thinking aloud?', 'tool_use'), assistant('¿Quieres que continúe?')]), '¿Quieres que continúe?');
  assert.equal(filterSettledSpeech([assistant('Listo: el archivo quedó actualizado.')]), 'Listo: el archivo quedó actualizado.');
  assert.equal(filterSettledSpeech([assistant('Estoy pensando en el siguiente paso.')]), undefined);
  assert.equal(filterSettledSpeech([assistant('¿Una pregunta?', 'tool_use')]), undefined);
  assert.equal(filterSettledSpeech([assistant('¿Una pregunta?'), user('next')]), undefined);
});

test('all reads prose but never code, diffs, or tool output', () => {
  assert.equal(filterSettledSpeech([assistant('Hola `token`.\n```ts\nconst secret = 1\n```\nResultado disponible.\n```diff\n-old\n+new\n```\n+ leaked\n@@ -1 +1 @@')], 'all'), 'Hola. Resultado disponible.');
  assert.equal(filterSettledSpeech([assistant('```\nonly code\n```')], 'all'), undefined);
  assert.equal(filterSettledSpeech([assistant('- Una respuesta útil.\n+ leaked\n@@ -1 +1 @@')], 'all'), 'Una respuesta útil.');
  assert.equal(filterSettledSpeech([{ role: 'toolResult', content: [{ type: 'text', text: 'Tool secret' }] }], 'all'), undefined);
  assert.equal(filterSettledSpeech([{ role: 'assistant', stopReason: 'end_turn', content: [{ type: 'toolCall', text: 'secret' }] }], 'all'), undefined);
});

test('default speaks declarative answers without result keywords and keeps Markdown bullets', () => {
  assert.equal(filterSettledSpeech([assistant('La capital de Francia es París.')]), 'La capital de Francia es París.');
  assert.equal(filterSettledSpeech([assistant('- La capital de Francia es París.\n- Su moneda es el euro.')]), 'La capital de Francia es París. Su moneda es el euro.');
  assert.equal(filterSettledSpeech([assistant('Estoy revisando los archivos.')]), undefined);
  assert.equal(filterSettledSpeech([assistant('La capital de Francia es París.', 'tool_use')]), undefined);
  assert.equal(filterSettledSpeech([{ role: 'toolResult', content: [{ type: 'text', text: 'La capital de Francia es París.' }] }]), undefined);
});

test('summary does not invent a sentence; generation belongs to integration', () => {
  assert.equal(filterSettledSpeech([assistant('¿Continuamos?')], 'summary'), undefined);
});

test('rejects unfinished, errored, or non-text assistant output', () => {
  assert.equal(filterSettledSpeech([assistant('¿Continuamos?', 'error')], 'all'), undefined);
  assert.equal(filterSettledSpeech([{ role: 'assistant', stopReason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }] }], 'all'), undefined);
});
