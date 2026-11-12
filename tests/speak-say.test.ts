/**
 * Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com
 * SPDX-License-Identifier: MIT
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the MIT License. See the LICENSE file in the root of
 * this project for the full license text.
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * MIT License for more details.
 * Email: victor.perez@e-evolution.com, http://www.e-evolution.com , http://github.com/e-Evolution
 * Created by victor.perez@e-evolution.com , www.e-evolution.com
 */
import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SAY_PATH, listSpanishSayVoices, parseSayVoices, pickMacVoice, sayAvailable, sayTimeoutMs, speakWithSay } from '../lib/speak-say.ts';

const LISTING = [
  'Eddy (Español (México)) es_MX    # ¡Hola! Me llamo Eddy.',
  'Eddy (Español (México)) es_MX    # ¡Hola! Me llamo Eddy.',
  'Flo (Español (España)) es_ES    # ¡Hola! Me llamo Flo.',
  'Paulina             es_MX    # Hola, me llamo Paulina.',
  'Mónica              es_ES    # Hola, me llamo Mónica.',
  'Samantha            en_US    # Hello, my name is Samantha.',
  'Grandma (Spanish (Spain)) es_ES    # Hola',
  '',
  'garbage line',
].join('\n');

test('parse: names with spaces or parenthesized locale, only es_*, deduplicated', () => {
  assert.deepEqual(parseSayVoices(LISTING), [
    { name: 'Eddy (Español (México))', locale: 'es_MX' },
    { name: 'Flo (Español (España))', locale: 'es_ES' },
    { name: 'Paulina', locale: 'es_MX' },
    { name: 'Mónica', locale: 'es_ES' },
    { name: 'Grandma (Spanish (Spain))', locale: 'es_ES' },
  ]);
  assert.deepEqual(parseSayVoices(''), []);
});

test('listSpanishSayVoices parses the injected runner and returns [] when it fails', async () => {
  assert.equal((await listSpanishSayVoices(async () => LISTING)).length, 5);
  assert.deepEqual(await listSpanishSayVoices(async () => { throw new Error('no say'); }), []);
});

test('pick order: preferred, Paulina, Mónica, first es_MX, first es_*, undefined', () => {
  const v = (name: string, locale: string) => ({ name, locale });
  const all = [v('Flo', 'es_ES'), v('Eddy', 'es_MX'), v('Mónica', 'es_ES'), v('Paulina', 'es_MX')];
  assert.equal(pickMacVoice(all, 'Flo'), 'Flo');
  assert.equal(pickMacVoice(all, 'Missing'), 'Paulina');
  assert.equal(pickMacVoice(all), 'Paulina');
  assert.equal(pickMacVoice(all.filter(x => x.name !== 'Paulina')), 'Mónica');
  assert.equal(pickMacVoice([v('Flo', 'es_ES'), v('Eddy', 'es_MX')]), 'Eddy');
  assert.equal(pickMacVoice([v('Flo', 'es_ES'), v('Sol', 'es_AR')]), 'Flo');
  assert.equal(pickMacVoice([]), undefined);
  assert.equal(pickMacVoice([], 'Paulina'), undefined);
  assert.equal(pickMacVoice(all, null), 'Paulina');
  // Real macOS listing: Paulina carries a locale suffix; the listed (valid for `say -v`) name is returned.
  const real = [v('Eddy (Español (España))', 'es_ES'), v('Eddy (Español (México))', 'es_MX'), v('Mónica', 'es_ES'), v('Paulina (Español (México))', 'es_MX')];
  assert.equal(pickMacVoice(real), 'Paulina (Español (México))');
  assert.equal(pickMacVoice(real.filter(x => !x.name.startsWith('Paulina'))), 'Mónica');
  assert.equal(pickMacVoice(real.filter(x => !/^(Paulina|Mónica)/.test(x.name))), 'Eddy (Español (México))');
});

test('sayAvailable needs darwin and an existing /usr/bin/say', () => {
  const seen: string[] = [];
  assert.equal(sayAvailable('darwin', p => { seen.push(p); return true; }), true);
  assert.deepEqual(seen, [SAY_PATH]);
  assert.equal(sayAvailable('darwin', () => false), false);
  assert.equal(sayAvailable('linux', () => true), false);
});

function fakeSpawn() {
  const calls: Array<{ file: string; args: string[]; stdin: string[]; ended: boolean; killed: string[]; child: any }> = [];
  const spawn = (file: string, args: string[]) => {
    const child: any = new EventEmitter();
    const rec = { file, args, stdin: [] as string[], ended: false, killed: [] as string[], child };
    child.stdin = { write: (c: string) => { rec.stdin.push(c); return true; }, end: () => { rec.ended = true; }, on() {} };
    child.kill = (s?: string) => { rec.killed.push(s ?? 'SIGTERM'); return true; };
    calls.push(rec);
    return child;
  };
  return { calls, spawn };
}

test('text goes on stdin only; argv is the fixed say invocation', async () => {
  const f = fakeSpawn();
  const text = 'Hola; $(rm -rf ~) "mundo" -v x';
  const p = speakWithSay({ voice: 'Eddy (Español (México))', text, speed: 1, spawn: f.spawn });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, '/usr/bin/say');
  assert.deepEqual(f.calls[0].args, ['-v', 'Eddy (Español (México))', '-r', '185', '-f', '-']);
  assert.equal(f.calls[0].args.some(a => a.includes('mundo')), false);
  assert.equal(f.calls[0].stdin.join(''), text);
  assert.equal(f.calls[0].ended, true);
  f.calls[0].child.emit('exit', 0);
  assert.deepEqual(await p, { ok: true, message: 'Speech completed.' });
});

test('rate is round(185 * speed)', async () => {
  for (const [speed, rate] of [[0.5, '93'], [1, '185'], [1.25, '231'], [2, '370']] as const) {
    const f = fakeSpawn();
    const p = speakWithSay({ voice: 'Paulina', text: 'x', speed, spawn: f.spawn });
    assert.equal(f.calls[0].args[3], rate, `speed ${speed}`);
    f.calls[0].child.emit('exit', 0); await p;
  }
});

test('non-zero exit, spawn error and spawn throw resolve ok:false', async () => {
  let f = fakeSpawn();
  let p = speakWithSay({ voice: 'Paulina', text: 'x', speed: 1, spawn: f.spawn });
  f.calls[0].child.emit('exit', 1);
  assert.equal((await p).ok, false);
  f = fakeSpawn();
  p = speakWithSay({ voice: 'Paulina', text: 'x', speed: 1, spawn: f.spawn });
  f.calls[0].child.emit('error', new Error('ENOENT'));
  assert.equal((await p).ok, false);
  const out = await speakWithSay({ voice: 'Paulina', text: 'x', speed: 1, spawn: () => { throw new Error('boom'); } });
  assert.equal(out.ok, false);
});

test('invalid voice names never spawn', async () => {
  const f = fakeSpawn();
  for (const voice of ['', 'a/b', 'x;y', 'a'.repeat(65)]) {
    const out = await speakWithSay({ voice, text: 'x', speed: 1, spawn: f.spawn });
    assert.equal(out.ok, false);
  }
  assert.equal(f.calls.length, 0);
});

test('abort kills the process and resolves cancelled; a pre-aborted signal never spawns', async () => {
  const f = fakeSpawn();
  const controller = new AbortController();
  const p = speakWithSay({ voice: 'Paulina', text: 'x', speed: 1, signal: controller.signal, spawn: f.spawn });
  controller.abort();
  const out = await p;
  assert.deepEqual(out, { ok: false, message: 'Speech cancelled.', cancelled: true });
  assert.deepEqual(f.calls[0].killed, ['SIGTERM']);
  f.calls[0].child.emit('exit', null); // a late exit changes nothing
  const pre = new AbortController(); pre.abort();
  const g = fakeSpawn();
  assert.equal((await speakWithSay({ voice: 'Paulina', text: 'x', speed: 1, signal: pre.signal, spawn: g.spawn })).cancelled, true);
  assert.equal(g.calls.length, 0);
});

test('timeout is proportional to the text length and kills the process', async () => {
  assert.ok(sayTimeoutMs('x'.repeat(4000), 1) > sayTimeoutMs('x'.repeat(100), 1));
  assert.ok(sayTimeoutMs('x'.repeat(100), 0.5) > sayTimeoutMs('x'.repeat(100), 2));
  const f = fakeSpawn();
  const out = await speakWithSay({ voice: 'Paulina', text: 'x', speed: 1, spawn: f.spawn, timeoutMs: 5 });
  assert.deepEqual(out, { ok: false, message: 'Mac voice timed out.' });
  assert.deepEqual(f.calls[0].killed, ['SIGTERM']);
});
