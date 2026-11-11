import './helpers/guard-real-home.ts';
// T38: the engine's hints to a shared-service connection (priority, cancel) and their absence for a plain worker.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQwenSpeech } from '../lib/speak-qwen.ts';

const QS = 'gentle.speak.qwen/v1';
const until = async (predicate: () => boolean) => { for (let i = 0; i < 300 && !predicate(); i++) await new Promise(r => setImmediate(r)); assert.ok(predicate(), 'condition not reached'); };
function child(hints: boolean) {
  const writes: any[] = [], cancels: number[] = [];
  const c: any = Object.assign(new EventEmitter(), { stdin: { write: (l: string) => { writes.push(JSON.parse(l)); return true; }, end() {} }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { return true; }, ...(hints ? { hints: true, cancelRequest: (id: number) => cancels.push(id) } : {}) });
  return { c, writes, cancels, emit: (m: object) => c.stdout.emit('data', JSON.stringify({ schema: QS, ...m }) + '\n') };
}
const setup = (hints: boolean) => {
  const root = mkdtempSync(join(tmpdir(), 'gsq-hint-')); const w = child(hints);
  const qwen = createQwenSpeech({ tmpRoot: root, idleMs: null, spawnPython: () => w.c, spawnAudio: () => { throw new Error('no audio'); } } as any);
  return { w, qwen, base: { python: '/py', ref: '/r.wav', refText: 'r', speed: 1 }, done: () => { qwen.dispose(); rmSync(root, { recursive: true, force: true }); } };
};

test('a service connection gets prepare/speak priorities and a cancel for an abandoned prepare', async () => {
  const s = setup(true);
  try {
    const prep = s.qwen.prepare({ ...s.base, text: 'Uno.' });
    await until(() => s.w.writes.length > 0 || true); s.w.emit({ type: 'ready' });
    await until(() => s.w.writes.some(x => x.type === 'synth'));
    assert.equal(s.w.writes[0].priority, 'prepare');
    s.qwen.speak({ ...s.base, text: 'Dos.', runtime: '/rt' }).catch(() => {});
    assert.equal((await prep).ok, false, 'a speak supersedes the prepare (T30b, client side)');
    assert.deepEqual(s.w.cancels, [s.w.writes[0].id], 'the abandoned prepare is cancelled at the service');
    await until(() => s.w.writes.filter(x => x.type === 'synth').length === 2);
    assert.equal(s.w.writes[1].priority, 'speak');
  } finally { s.done(); }
});

test('a plain worker never gets the hints (its protocol rejects unknown keys)', async () => {
  const s = setup(false);
  try {
    const prep = s.qwen.prepare({ ...s.base, text: 'Uno.' });
    s.w.emit({ type: 'ready' });
    await until(() => s.w.writes.some(x => x.type === 'synth'));
    assert.deepEqual(Object.keys(s.w.writes[0]).sort(), ['id', 'outDir', 'ref', 'refText', 'schema', 'speed', 'text', 'type']);
    s.w.emit({ type: 'done', id: s.w.writes[0].id });
    assert.equal((await prep).ok, true);
    assert.deepEqual(s.w.cancels, []);
  } finally { s.done(); }
});
