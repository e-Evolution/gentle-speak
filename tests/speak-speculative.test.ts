import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeculativePlanner, completedSentences } from '../lib/speak-speculative.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
/** A planner over a controllable fake synthesizer; every call is recorded and resolved by the test. */
function fixture(options: { maxAheadChars?: number; prepare?: (text: string) => string | undefined } = {}) {
  const calls: Array<{ text: string; signal: AbortSignal; resolve: (wavs: string[] | 'fail') => void }> = [];
  const discarded: string[][] = [];
  const planner = createSpeculativePlanner({
    ...options,
    synthesize: (text, signal) => new Promise(resolve => {
      calls.push({ text, signal, resolve: wavs => resolve(wavs === 'fail' ? { ok: false, message: 'boom' } : { ok: true, wavs }) });
    }),
    discard: wavs => { discarded.push([...wavs]); },
  });
  const finish = async (index: number, wavs: string[] | 'fail' = [`/t/${index}.wav`]) => { calls[index].resolve(wavs); await tick(); };
  return { planner, calls, discarded, finish };
}

test('only completed sentences are synthesized; the trailing incomplete part never is', async () => {
  const f = fixture();
  f.planner.update('Hola mundo');
  f.planner.update('Hola mundo.');            // a terminator without following whitespace is not complete yet
  await tick();
  assert.equal(f.calls.length, 0);
  f.planner.update('Hola mundo. Segunda par');
  await tick();
  assert.deepEqual(f.calls.map(c => c.text), ['Hola mundo.']);
  await f.finish(0);
  assert.equal(f.calls.length, 1, 'the incomplete "Segunda par" is not synthesized');
});

test('sentence ends: . ! ? … followed by whitespace, and a paragraph break', () => {
  assert.deepEqual(completedSentences('Uno. Dos! Tres? Cuatro… Cinco'), ['Uno.', 'Dos!', 'Tres?', 'Cuatro…']);
  assert.deepEqual(completedSentences('Titulo sin punto\n\nSegundo parrafo'), ['Titulo sin punto']);
  assert.deepEqual(completedSentences('Fin. '), ['Fin.']);
  assert.deepEqual(completedSentences('Fin.'), []);
  assert.deepEqual(completedSentences('1. Primero. Segundo. x'), ['1. Primero.', 'Segundo.']);
});

test('the same preparation as S1: markdown emphasis and inline code are not spoken', () => {
  assert.deepEqual(completedSentences('Esto es **muy** importante `foo()`. Siguiente'), ['Esto es muy importante.']);
});

test('code inside a still-open fence is excluded, and a closed fence is skipped', () => {
  assert.deepEqual(completedSentences('Antes. Texto.\n\n```ts\nconst a = 1. Nope. Nada.\n\nmas codigo. Otro. '), ['Antes.', 'Texto.']);
  assert.deepEqual(completedSentences('Antes.\n\n```\ncodigo. aqui.\n```\n\nDespues. fin'), ['Antes.', 'Despues.']);
});

test('the prepare function is injectable', async () => {
  const f = fixture({ prepare: text => text.toUpperCase() });
  f.planner.update('hola. adios');
  await tick();
  assert.deepEqual(f.calls.map(c => c.text), ['HOLA.']);
});

test('at most one synthesis is in flight; the next starts only when it finishes', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. Tres. ');
  await tick();
  assert.deepEqual(f.calls.map(c => c.text), ['Uno.']);
  f.planner.update('Uno. Dos. Tres. Cuatro. ');
  await tick();
  assert.equal(f.calls.length, 1);
  await f.finish(0);
  assert.deepEqual(f.calls.map(c => c.text), ['Uno.', 'Dos.']);
  await f.finish(1);
  assert.deepEqual(f.calls.map(c => c.text), ['Uno.', 'Dos.', 'Tres.']);
});

test('speculated text pending or buffered never exceeds maxAheadChars (default 500)', async () => {
  const sentence = (n: number) => `${String(n).padStart(2, '0')} ${'x'.repeat(96)}.`; // 100 chars
  const f = fixture();
  f.planner.update(Array.from({ length: 8 }, (_, i) => sentence(i)).join(' ') + ' ');
  for (let i = 0; i < 8; i++) { await tick(); if (f.calls[i]) await f.finish(i); }
  assert.equal(f.calls.length, 5, '5 x 100 chars = 500 fits, the 6th does not');
  const small = fixture({ maxAheadChars: 25 });
  small.planner.update('Doce chars. Doce chars. Doce chars. ');
  await tick(); await small.finish(0); await tick();
  assert.equal(small.calls.length, 2, '11 + 11 = 22 fits in 25, a third does not');
});

test('settle with an exact prefix returns the buffered WAVs in order and the remainder', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. ');
  await tick(); await f.finish(0, ['/t/a.wav']); await f.finish(1, ['/t/b1.wav', '/t/b2.wav']);
  const settlement = f.planner.settle('Uno.  Dos.\nTres cosas.');
  assert.deepEqual(settlement, { wavs: ['/t/a.wav', '/t/b1.wav', '/t/b2.wav'], matchedText: 'Uno. Dos.', remainderText: 'Tres cosas.' });
  assert.deepEqual(f.discarded, []);
});

test('settle with a partial match keeps the longest prefix and deletes the rest', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. Tres. ');
  await tick(); await f.finish(0, ['/t/a.wav']); await f.finish(1, ['/t/b.wav']); await f.finish(2, ['/t/c.wav']);
  const settlement = f.planner.settle('Uno. Distinto. Tres.');
  assert.deepEqual(settlement, { wavs: ['/t/a.wav'], matchedText: 'Uno.', remainderText: 'Distinto. Tres.' });
  assert.deepEqual(f.discarded, [['/t/b.wav'], ['/t/c.wav']]);
});

test('settle with a mismatch plays nothing, deletes every WAV, aborts the in-flight synthesis and returns the whole text', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. ');
  await tick(); await f.finish(0, ['/t/a.wav']);
  assert.equal(f.calls.length, 2);
  const settlement = f.planner.settle('Otra cosa.');
  assert.deepEqual(settlement, { wavs: [], matchedText: '', remainderText: 'Otra cosa.' });
  assert.deepEqual(f.discarded, [['/t/a.wav']]);
  assert.equal(f.calls[1].signal.aborted, true);
  await f.finish(1, ['/t/late.wav']);
  assert.deepEqual(f.discarded, [['/t/a.wav'], ['/t/late.wav']], 'a result arriving after settle is deleted, not leaked');
});

test('a match must end on a word boundary of the final text', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. ');
  await tick(); await f.finish(0, ['/t/a.wav']);
  assert.deepEqual(f.planner.settle('Uno.5 mas.'), { wavs: [], matchedText: '', remainderText: 'Uno.5 mas.' });
  assert.deepEqual(f.discarded, [['/t/a.wav']]);
});

test('text that no longer extends the speculation discards it and starts again', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. ');
  await tick(); await f.finish(0, ['/t/a.wav']);
  f.planner.update('Cambio. ');
  await tick();
  assert.deepEqual(f.discarded, [['/t/a.wav']]);
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.calls.at(-1)!.text, 'Cambio.');
});

test('cancel discards the buffer, aborts the in-flight synthesis, and the planner is reusable', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. ');
  await tick(); await f.finish(0, ['/t/a.wav']);
  f.planner.cancel();
  assert.deepEqual(f.discarded, [['/t/a.wav']]);
  assert.equal(f.calls[1].signal.aborted, true);
  assert.deepEqual(f.planner.settle('Uno. Dos.'), { wavs: [], matchedText: '', remainderText: 'Uno. Dos.' });
  await f.finish(1, ['/t/late.wav']);
  assert.deepEqual(f.discarded.at(-1), ['/t/late.wav']);
  f.planner.update('Nuevo. ');
  await tick();
  assert.equal(f.calls.at(-1)!.text, 'Nuevo.');
});

test('dispose is permanent: it discards, aborts, and later updates synthesize nothing', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. ');
  await tick(); await f.finish(0, ['/t/a.wav']);
  f.planner.dispose();
  assert.deepEqual(f.discarded, [['/t/a.wav']]);
  assert.equal(f.calls[1].signal.aborted, true);
  f.planner.update('Tres. Cuatro. ');
  await tick();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.planner.settle('Uno.'), { wavs: [], matchedText: '', remainderText: 'Uno.' });
});

test('a failed synthesis stops speculating without retrying; settle returns the matched part', async () => {
  const f = fixture();
  f.planner.update('Uno. Dos. Tres. ');
  await tick(); await f.finish(0, ['/t/a.wav']); await f.finish(1, 'fail');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.planner.settle('Uno. Dos. Tres.'), { wavs: ['/t/a.wav'], matchedText: 'Uno.', remainderText: 'Dos. Tres.' });
});
