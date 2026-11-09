import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFocusCheck, createLatestOnlyDeferral, probeHerdrFocus, projectPrefix } from '../lib/speak-focus.ts';

const herdrEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'w4:p1' };
const reply = (focused: unknown) => async () => JSON.stringify({ result: { pane: { focused, id: 'w4:p1' } } });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('probe: focused true/false map to focused/unfocused and run `herdr pane get <id>`', async () => {
  const calls: any[] = [];
  const exec = async (file: string, args: string[], opts: { timeoutMs: number }) => { calls.push({ file, args, opts }); return reply(true)(); };
  assert.equal(await probeHerdrFocus({ env: herdrEnv, exec, timeoutMs: 700 }), 'focused');
  assert.deepEqual(calls[0], { file: 'herdr', args: ['pane', 'get', 'w4:p1'], opts: { timeoutMs: 700 } });
  assert.equal(await probeHerdrFocus({ env: herdrEnv, exec: reply(false), timeoutMs: 700 }), 'unfocused');
});

test('probe: HERDR_BIN_PATH replaces the herdr binary', async () => {
  let file = '';
  await probeHerdrFocus({ env: { ...herdrEnv, HERDR_BIN_PATH: '/opt/herdr' }, exec: async f => { file = f; return reply(true)(); }, timeoutMs: 1 });
  assert.equal(file, '/opt/herdr');
});

test('probe: unknown without Herdr env, without pane id, and never execs', async () => {
  let ran = 0;
  const exec = async () => { ran++; return reply(true)(); };
  assert.equal(await probeHerdrFocus({ env: {}, exec, timeoutMs: 1 }), 'unknown');
  assert.equal(await probeHerdrFocus({ env: { HERDR_ENV: '0', HERDR_PANE_ID: 'x' }, exec, timeoutMs: 1 }), 'unknown');
  assert.equal(await probeHerdrFocus({ env: { HERDR_ENV: '1' }, exec, timeoutMs: 1 }), 'unknown');
  assert.equal(ran, 0);
});

test('probe: unknown on exec error, timeout, bad JSON and unexpected shape', async () => {
  const p = (exec: any) => probeHerdrFocus({ env: herdrEnv, exec, timeoutMs: 20 });
  assert.equal(await p(async () => { throw new Error('boom'); }), 'unknown');
  assert.equal(await p(() => new Promise(() => {})), 'unknown');
  assert.equal(await p(async () => 'not json'), 'unknown');
  assert.equal(await p(async () => '{"result":{}}'), 'unknown');
  assert.equal(await p(reply('yes')), 'unknown');
  assert.equal(await p(async () => 'null'), 'unknown');
});

test('focus check: focused only when terminal frontmost and Herdr focused; unknown follows Herdr', async () => {
  const mk = (herdr: any, front: boolean | Error) => createFocusCheck({
    probeHerdr: async () => herdr,
    isTerminalFrontmost: async () => { if (front instanceof Error) throw front; return front; },
  })();
  assert.equal(await mk('focused', true), 'focused');
  assert.equal(await mk('focused', false), 'unfocused');
  assert.equal(await mk('unfocused', true), 'unfocused');
  assert.equal(await mk('unknown', true), 'unknown');
  assert.equal(await mk('unknown', false), 'unknown');
  assert.equal(await mk('focused', new Error('x')), 'unfocused');
});

test('projectPrefix uses the cwd basename', () => {
  assert.equal(projectPrefix('/home/u/gentle-theme', 'hola'), 'gentle-theme: hola');
  assert.equal(projectPrefix('/home/u/gentle-theme/', 'hola'), 'gentle-theme: hola');
});

function harness(initial: 'focused' | 'unfocused' | 'unknown') {
  const state = { focus: initial };
  const delivered: any[] = [];
  const d = createLatestOnlyDeferral<string>({
    checkFocus: async () => state.focus,
    pollMs: 5,
    onReady: (item, o) => { delivered.push([item, o?.prefixProject === true]); },
  });
  return { state, delivered, d };
}

test('deferral: focused speaks now, unknown speaks now with prefixProject', async () => {
  const f = harness('focused');
  await f.d.offer('a');
  assert.deepEqual(f.delivered, [['a', false]]);
  const u = harness('unknown');
  await u.d.offer('b');
  assert.deepEqual(u.delivered, [['b', true]]);
  f.d.dispose(); u.d.dispose();
});

test('deferral: unfocused keeps only the latest and delivers once when focus arrives', async () => {
  const h = harness('unfocused');
  await h.d.offer('one');
  await h.d.offer('two');
  await h.d.offer('three');
  await sleep(30);
  assert.deepEqual(h.delivered, []);
  h.state.focus = 'focused';
  await sleep(40);
  assert.deepEqual(h.delivered, [['three', false]]);
  await sleep(30);
  assert.equal(h.delivered.length, 1);
  h.d.dispose();
});

test('deferral: pending item delivered with prefix if focus becomes unknown', async () => {
  const h = harness('unfocused');
  await h.d.offer('x');
  h.state.focus = 'unknown';
  await sleep(40);
  assert.deepEqual(h.delivered, [['x', true]]);
  h.d.dispose();
});

test('deferral: clear drops the pending item and stops polling, new offers still work', async () => {
  const h = harness('unfocused');
  await h.d.offer('x');
  h.d.clear();
  h.state.focus = 'focused';
  await sleep(30);
  assert.deepEqual(h.delivered, []);
  await h.d.offer('y');
  assert.deepEqual(h.delivered, [['y', false]]);
  h.d.dispose();
});

test('deferral: dispose is permanent', async () => {
  const h = harness('unfocused');
  await h.d.offer('x');
  h.d.dispose();
  h.state.focus = 'focused';
  await sleep(30);
  await h.d.offer('z');
  assert.deepEqual(h.delivered, []);
});

test('deferral: a newer offer replaces an item whose focus check is in flight', async () => {
  let release: (v: 'focused') => void = () => {};
  let first = true;
  const delivered: string[] = [];
  const d = createLatestOnlyDeferral<string>({
    checkFocus: () => first ? ((first = false), new Promise(r => { release = r as any; })) : Promise.resolve('unfocused'),
    pollMs: 5,
    onReady: item => { delivered.push(item); },
  });
  const p = d.offer('old');
  const q = d.offer('new');
  release('focused');
  await Promise.all([p, q]);
  await sleep(20);
  assert.deepEqual(delivered, []); // 'old' was replaced before its check resolved; 'new' is still unfocused
  d.dispose();
});

test('deferral: checkFocus failure counts as unknown', async () => {
  const delivered: any[] = [];
  const d = createLatestOnlyDeferral<string>({
    checkFocus: async () => { throw new Error('x'); }, pollMs: 5,
    onReady: (i, o) => { delivered.push([i, o?.prefixProject === true]); },
  });
  await d.offer('a');
  assert.deepEqual(delivered, [['a', true]]);
  d.dispose();
});
