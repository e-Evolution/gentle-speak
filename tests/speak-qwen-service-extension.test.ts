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
// T38: the extension wired to the shared service: two sessions, one Python; the /speak action that stops it; the injected-worker path unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SPEAK_SETTINGS, SPEAK_SETTINGS_SCHEMA } from '../lib/speak-settings.ts';
import gentleSpeak from '../extensions/gentle-speak.ts';
import { hermetic } from './helpers/hermetic.ts';
import { qwenFixture, until } from './helpers/qwen-service-fixture.ts';
import { writeEntry } from './helpers/custom-voice-fixture.ts';

const fakeAudio = () => {
  const child: any = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; },
    stdin: { write: (line: string) => { const m = JSON.parse(line); if (m.type === 'play') setImmediate(() => child.stdout.emit('data', JSON.stringify({ schema: 'gentle.speak/v1', type: 'done', id: m.id }) + '\n')); return true; }, end() {} } });
  return child;
};
function session(fx: ReturnType<typeof qwenFixture>, extra: object = {}) {
  const tools = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, Function>(), notes: string[] = [], selections: string[] = [];
  const ctx: any = { mode: 'tui', hasUI: true, sessionManager: { getHeader: () => ({ type: 'session' }), getBranch: () => [] }, ui: { notify: (t: string) => notes.push(t), setStatus() {}, select: async () => selections.shift() } };
  const deps = { ...hermetic(fx.home), modelStatus: async () => ({ state: 'installed', path: '/m' }), runtimeStatus: async () => ({ state: 'installed', path: '/r' }), spawn: () => fakeAudio(), qwenTmpRoot: fx.root, focusCheck: async () => 'focused', sayAvailable: () => false, ...extra };
  gentleSpeak({ on: (n: string, h: Function) => events.set(n, h), registerCommand: (n: string, c: any) => commands.set(n, c), registerShortcut() {}, registerTool: (t: any) => tools.set(t.name, t) } as any, fx.home, deps as any);
  return { tools, commands, events, notes, selections, ctx, speak: (text: string) => tools.get('speak').execute('id', { text }, undefined, undefined, ctx), end: () => events.get('session_shutdown')?.({}, ctx) };
}
function prepare(fx: ReturnType<typeof qwenFixture>) {
  writeEntry(join(fx.home, 'voices', 'custom'), 'intima', { wav: Buffer.from('RIFF') }); // T45: the user's own voice
  writeFileSync(join(fx.home, 'python.json'), JSON.stringify({ schema: 'gentle-speak.python/v1', python: fx.options().python }));
  writeFileSync(join(fx.home, 'speak-settings.json'), JSON.stringify({ schema: SPEAK_SETTINGS_SCHEMA, ...DEFAULT_SPEAK_SETTINGS, enabled: true, voice: 'custom:intima', qwenIdleMinutes: null }));
}
const serviceOptions = (fx: ReturnType<typeof qwenFixture>) => { const { python: _p, idleMs: _i, ...rest } = fx.options(); return rest; };

test('two extension sessions speak through one shared Python, and /speak can stop the service', async () => {
  const fx = qwenFixture();
  try {
    prepare(fx);
    const a = session(fx, { qwenService: serviceOptions(fx) }), b = session(fx, { qwenService: serviceOptions(fx) });
    await a.speak('Hola desde A.'); await b.speak('Hola desde B.');
    assert.equal(fx.workerPids().length, 1, 'one Python for two sessions');
    assert.deepEqual(fx.read('order.log'), ['Hola desde A.', 'Hola desde B.']);
    a.selections.push('Detener servicio Qwen');
    await a.commands.get('speak').handler('', a.ctx);
    assert.ok(a.notes.some(n => /Qwen service stopped/.test(n)));
    await until(() => !existsSync(fx.paths.socket), 'socket removed');
    await until(() => !fx.isAlive(fx.workerPids()[0]), 'its Python stopped with it');
    a.end(); b.end();
  } finally { await fx.close(); }
});

test('an injected spawnQwen keeps the per-session worker path: no service, no menu entry', async () => {
  const fx = qwenFixture();
  try {
    prepare(fx);
    const offered: string[][] = [];
    const s = session(fx, { spawnQwen: () => { throw new Error('not started in this test'); } });
    s.ctx.ui.select = async (_t: string, o: string[]) => { offered.push(o); return undefined; };
    await s.commands.get('speak').handler('', s.ctx);
    assert.ok(!offered[0].includes('Detener servicio Qwen'));
    assert.equal(existsSync(fx.paths.socket), false);
    s.end();
  } finally { await fx.close(); }
});
