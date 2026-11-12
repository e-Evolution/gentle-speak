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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { baseModelStatus, designModelStatus } from '../lib/speak-voices-install.ts';
import { QWEN_DESIGN_MODEL_ID, QWEN_MODEL_ID } from '../lib/speak-voices.ts';
import { PYTHON_INSTRUCTION } from '../lib/speak-python-env.ts';
import { SPEAK_MODELS, speakRuntimeManifest } from '../lib/speak-install.ts';
import { QWEN_BASE_APPROX_BYTES, QWEN_BASE_SIZE_SOURCE_API, QWEN_BASE_SIZE_SOURCE_APPROX, computeSetupPlan, describeSetupPlan, ffmpegHint, ffmpegStatus, formatBytes, runSetup, summarizeSetup, type SetupEnv, type SetupInstallers, type SetupProgress } from '../lib/speak-setup.ts';

// T44 (S15): the setup plan and the sequential install. Every probe and installer is a fake: nothing downloads, runs or touches a real path.
const runtimeBytes = (target: string) => speakRuntimeManifest(target as any).packages.reduce((sum, pkg) => sum + pkg.size, 0);
const piperBytes = SPEAK_MODELS.es_MX.files.reduce((sum, file) => sum + file.size, 0);

type Over = Partial<SetupEnv> & { states?: Partial<Record<'runtime' | 'piper' | 'python' | 'base', string>>; api?: number | undefined | 'throw' };
function env(o: Over = {}): SetupEnv & { calls: string[] } {
  const calls: string[] = [], st = { runtime: 'missing', piper: 'missing', python: 'missing', base: 'missing', ...o.states };
  return {
    calls, home: '/h', target: 'darwin-arm64', platform: 'darwin', hfHome: '/hf', which: () => '/bin/uv',
    runtimeStatus: async () => ({ state: st.runtime as any }), modelStatus: async () => ({ state: st.piper as any }),
    pythonStatus: async () => ({ state: st.python as any }), tooling: async () => ({ kind: 'uv', uv: '/bin/uv' }),
    baseStatus: async () => st.base as any, baseSize: async () => { calls.push('baseSize'); if (o.api === 'throw') throw new Error('offline'); return o.api === undefined ? 2_400_000_000 : o.api; },
    ...o,
  } as any;
}

test('the plan lists only what is missing, each with its size; installed parts are left out of what installs', async () => {
  const all = await computeSetupPlan(env({ states: { runtime: 'installed', piper: 'installed', python: 'installed', base: 'installed' } }));
  assert.deepEqual(all.actionable, []); assert.equal(all.totalBytes, 0); assert.deepEqual(all.missing, []);
  const some = await computeSetupPlan(env({ states: { runtime: 'installed', piper: 'missing', python: 'installed', base: 'missing' }, api: 2_000_000_000 }));
  assert.deepEqual(some.actionable.map(c => c.id), ['piper', 'qwen-base']);
  assert.equal(some.totalBytes, piperBytes + 2_000_000_000);
  const full = await computeSetupPlan(env());
  assert.deepEqual(full.actionable.map(c => c.id), ['runtime', 'piper', 'python', 'qwen-base']);
  assert.equal(full.components.find(c => c.id === 'runtime')!.bytes, runtimeBytes('darwin-arm64'));
  assert.equal(full.components.find(c => c.id === 'piper')!.bytes, piperBytes);
  assert.ok(full.components.every(c => c.bytes > 0 && c.sizeSource.length > 0), 'every size states its source');
});

test('the Base model size comes from the Hugging Face API; without it, a stated approximate with its source', async () => {
  const api = await computeSetupPlan(env({ api: 2_345_000_000 }));
  const fromApi = api.components.find(c => c.id === 'qwen-base')!;
  assert.deepEqual([fromApi.bytes, fromApi.sizeSource], [2_345_000_000, QWEN_BASE_SIZE_SOURCE_API]);
  for (const down of [undefined as any, 'throw' as const]) {
    const plan = await computeSetupPlan(env({ baseSize: async () => { if (down === 'throw') throw new Error('offline'); return undefined; } }));
    const base = plan.components.find(c => c.id === 'qwen-base')!;
    assert.deepEqual([base.bytes, base.sizeSource], [QWEN_BASE_APPROX_BYTES, QWEN_BASE_SIZE_SOURCE_APPROX]);
    assert.match(describeSetupPlan(plan), /aprox\./);
  }
  const installed = env({ states: { base: 'installed' } });
  await computeSetupPlan(installed);
  assert.equal(installed.calls.includes('baseSize'), false, 'an installed model never asks the API');
});

test('off darwin-arm64 the Qwen components are excluded and nothing asks the API or probes Python', async () => {
  for (const target of ['darwin-x64', 'linux-x64', 'win32-x64', 'linux-arm64']) {
    const e = env({ target, platform: target.split('-')[0], tooling: async () => { throw new Error('probed'); } });
    const plan = await computeSetupPlan(e);
    assert.deepEqual(plan.components.map(c => c.id), ['runtime', 'piper'], target);
    assert.equal(plan.qwenSupported, false); assert.equal(e.calls.includes('baseSize'), false, target);
    assert.doesNotMatch(describeSetupPlan(plan), /Qwen|Python|mlx/);
  }
});

test('VoiceDesign is never part of the plan, the confirmation or the install', async () => {
  const plan = await computeSetupPlan(env());
  assert.equal(plan.components.some(c => /design/i.test(c.id + c.label)), false);
  assert.doesNotMatch(describeSetupPlan(plan), /VoiceDesign|1\.7B/);
  const seen: string[] = [];
  const installers = fakeInstallers(seen);
  await runSetup({ plan, env: { home: '/h', target: 'darwin-arm64', hfHome: '/hf' }, installers });
  assert.equal(seen.some(s => /design/i.test(s)), false);
});

test('the confirmation text lists every actionable component with size, source and the total, in plain text', async () => {
  const plan = await computeSetupPlan(env({ api: 2_000_000_000 }));
  const text = describeSetupPlan(plan);
  for (const c of plan.actionable) assert.ok(text.includes(`${c.label}: ${formatBytes(c.bytes)} (${c.sizeSource})`), c.id);
  assert.ok(text.includes(`Total: ${formatBytes(plan.totalBytes)}`));
  assert.doesNotMatch(text, /\u001b\[/);
  assert.equal(formatBytes(2_500_000_000), '2.5 GB'); assert.equal(formatBytes(60_000_000), '60 MB');
});

test('without uv or a suitable Python the env and the Base model are blocked with the instruction, and excluded from the total', async () => {
  const plan = await computeSetupPlan(env({ tooling: async () => ({ kind: 'none', instruction: PYTHON_INSTRUCTION }) }));
  assert.deepEqual(plan.actionable.map(c => c.id), ['runtime', 'piper']);
  assert.equal(plan.totalBytes, runtimeBytes('darwin-arm64') + piperBytes);
  assert.deepEqual(plan.missing.filter(c => c.blocked).map(c => c.id), ['python', 'qwen-base']);
  assert.ok(describeSetupPlan(plan).includes(PYTHON_INSTRUCTION));
  const withEnv = await computeSetupPlan(env({ states: { python: 'installed' }, tooling: async () => ({ kind: 'none', instruction: PYTHON_INSTRUCTION }) }));
  assert.deepEqual(withEnv.actionable.map(c => c.id), ['runtime', 'piper', 'qwen-base'], 'an existing env needs no tooling');
});

test('an invalid installation is reported but never replaced; a throwing probe counts as invalid, not as missing', async () => {
  const plan = await computeSetupPlan(env({ states: { runtime: 'invalid' }, modelStatus: async () => { throw new Error('boom'); } }));
  assert.deepEqual(plan.actionable.map(c => c.id), ['python', 'qwen-base']);
  assert.deepEqual(plan.components.filter(c => c.state === 'invalid').map(c => c.id), ['runtime', 'piper']);
  assert.match(describeSetupPlan(plan), /instalación inválida/);
});

test('ffmpeg: detected through PATH; the hint is brew install ffmpeg on macOS and the platform equivalent elsewhere; never installed', async () => {
  const asked: string[] = [];
  const missing = ffmpegStatus(n => { asked.push(n); return undefined; }, 'darwin');
  assert.deepEqual(missing, { present: false, path: undefined, hint: 'brew install ffmpeg' });
  assert.deepEqual(asked, ['ffmpeg', 'ffmpeg']);
  assert.equal(ffmpegHint('darwin'), 'brew install ffmpeg'); assert.match(ffmpegHint('linux'), /apt install ffmpeg/); assert.match(ffmpegHint('win32'), /winget install ffmpeg/);
  assert.deepEqual(ffmpegStatus(n => `/usr/bin/${n}`, 'darwin'), { present: true, path: '/usr/bin/ffmpeg', hint: 'brew install ffmpeg' });
  const plan = await computeSetupPlan(env({ which: () => undefined }));
  assert.ok(plan.ffmpeg.hint === 'brew install ffmpeg' && !plan.ffmpeg.present);
  assert.match(describeSetupPlan(plan), /ffmpeg no está instalado.*brew install ffmpeg/);
  assert.doesNotMatch(describeSetupPlan(await computeSetupPlan(env({ which: () => '/usr/bin/ffmpeg' }))), /ffmpeg/);
  assert.match(summarizeSetup([{ id: 'piper', label: 'Piper', status: 'installed' }], plan.ffmpeg), /^gentle-speak listo\nffmpeg: .*brew install ffmpeg/);
});

function fakeInstallers(seen: string[], o: { fail?: string[]; python?: 'installed' | 'skipped' | 'failed'; delay?: number } = {}): SetupInstallers {
  let running = 0, overlap = false;
  const work = async (name: string, extra?: () => void) => {
    seen.push(`start:${name}`); running++; if (running > 1) overlap = true;
    await new Promise(r => setTimeout(r, o.delay ?? 1)); extra?.(); running--;
    seen.push(`end:${name}`);
    if (o.fail?.includes(name)) throw new Error(`${name} fallo en /secret/path/x`);
    if (overlap) throw new Error('OVERLAP');
  };
  return {
    installRuntime: async opts => { await work('runtime', () => opts.onProgress?.(50, 100)); return {}; },
    installPiper: async opts => { await work('piper', () => opts.onProgress?.(100, 100)); return {}; },
    ensurePython: async opts => {
      await work('python', () => opts.onProgress?.('Creando el entorno con uv…'));
      return o.python === 'skipped' ? { status: 'skipped', instruction: PYTHON_INSTRUCTION } : o.python === 'failed' ? { status: 'failed', message: 'no pude instalar mlx-audio' } : { status: 'installed', python: '/h/python/bin/python', version: '0.4.4', tool: 'uv', alreadyInstalled: false };
    },
    installBase: async opts => { assert.equal(opts.python, '/h/python/bin/python'); assert.equal(opts.confirmed, true); await work('base'); },
    resolvePython: () => undefined,
  };
}
const target = { home: '/h', target: 'darwin-arm64', hfHome: '/hf' };

test('everything installs one after another with progress, and the summary is «gentle-speak listo»', async () => {
  const plan = await computeSetupPlan(env());
  const seen: string[] = [], progress: SetupProgress[] = [];
  const results = await runSetup({ plan, env: target, installers: fakeInstallers(seen), onProgress: p => progress.push(p) });
  assert.deepEqual(seen, ['start:runtime', 'end:runtime', 'start:piper', 'end:piper', 'start:python', 'end:python', 'start:base', 'end:base']);
  assert.deepEqual(results.map(r => [r.id, r.status]), [['runtime', 'installed'], ['piper', 'installed'], ['python', 'installed'], ['qwen-base', 'installed']]);
  assert.deepEqual(progress.filter(p => p.phase === 'start').map(p => p.component), ['runtime', 'piper', 'python', 'qwen-base']);
  assert.ok(progress.some(p => p.component === 'runtime' && p.phase === 'progress' && p.received === 50 && p.total === 100));
  assert.ok(progress.some(p => p.component === 'python' && p.phase === 'progress' && p.message === 'Creando el entorno con uv…'));
  assert.deepEqual(progress.filter(p => p.phase === 'done').map(p => p.component), ['runtime', 'piper', 'python', 'qwen-base']);
  assert.equal(summarizeSetup(results, { present: true, hint: '' }), 'gentle-speak listo');
});

test('only the missing components install; an already installed one is not touched', async () => {
  const plan = await computeSetupPlan(env({ states: { runtime: 'installed', python: 'installed' } }));
  const seen: string[] = [];
  const installers = { ...fakeInstallers(seen), resolvePython: () => '/h/python/bin/python' };
  await runSetup({ plan, env: target, installers });
  assert.deepEqual(seen.filter(s => s.startsWith('start:')), ['start:piper', 'start:base']);
});

test('a component that fails stops only itself: the others still install and the summary has one line per component', async () => {
  const plan = await computeSetupPlan(env());
  const seen: string[] = [];
  const results = await runSetup({ plan, env: target, installers: fakeInstallers(seen, { fail: ['runtime'] }) });
  assert.deepEqual(results.map(r => r.status), ['failed', 'installed', 'installed', 'installed']);
  assert.equal(results[0].message, 'runtime fallo en', 'a path never leaks into the message');
  const summary = summarizeSetup(results, { present: true, hint: '' });
  assert.match(summary, /instalación incompleta/); assert.match(summary, /✗ Runtime de audio nativo.*: runtime fallo en/); assert.match(summary, /✓ Voz Piper es_MX/); assert.match(summary, /✓ Modelo Qwen3-TTS Base 0.6B/);
  assert.equal(summary.split('\n').filter(l => /^[✓✗–]/.test(l)).length, 4);
  assert.doesNotMatch(summary, /gentle-speak listo/);
});

test('when the Python env does not install (skipped or failed) the Base model is skipped, the rest is unaffected', async () => {
  for (const python of ['skipped', 'failed'] as const) {
    const plan = await computeSetupPlan(env());
    const seen: string[] = [];
    const results = await runSetup({ plan, env: target, installers: fakeInstallers(seen, { python }) });
    assert.deepEqual(results.map(r => [r.id, r.status]), [['runtime', 'installed'], ['piper', 'installed'], ['python', python === 'skipped' ? 'skipped' : 'failed'], ['qwen-base', 'skipped']], python);
    assert.equal(seen.includes('start:base'), false);
    assert.match(results[3].message!, /necesita el entorno Python/);
    const summary = summarizeSetup(results, { present: true, hint: '' });
    assert.match(summary, /– Modelo Qwen3-TTS Base/);
  }
});

test('the Base model uses an environment that already exists (resolvePython) when the plan does not install one', async () => {
  const plan = await computeSetupPlan(env({ states: { python: 'installed' } }));
  const seen: string[] = [];
  const results = await runSetup({ plan, env: target, installers: { ...fakeInstallers(seen), resolvePython: () => '/h/python/bin/python' } });
  assert.deepEqual(results.map(r => r.id), ['runtime', 'piper', 'qwen-base']); assert.ok(results.every(r => r.status === 'installed'));
});

test('off darwin-arm64 the Python env and the Base model are never installed or resolved', async () => {
  const plan = await computeSetupPlan(env({ target: 'linux-x64', platform: 'linux' }));
  const seen: string[] = [];
  let resolved = false;
  const results = await runSetup({ plan, env: { ...target, target: 'linux-x64' }, installers: { ...fakeInstallers(seen), resolvePython: () => { resolved = true; return undefined; } } });
  assert.deepEqual(seen.filter(s => s.startsWith('start:')), ['start:runtime', 'start:piper']); assert.equal(resolved, false); assert.equal(results.length, 2);
});

test('a cancelled setup skips what has not started and says so', async () => {
  const plan = await computeSetupPlan(env());
  const controller = new AbortController();
  const seen: string[] = [];
  const installers = fakeInstallers(seen);
  const first = installers.installRuntime;
  installers.installRuntime = async o => { const out = await first(o); controller.abort(); return out; };
  const results = await runSetup({ plan, env: target, installers, signal: controller.signal });
  assert.deepEqual(results.map(r => [r.id, r.status]), [['runtime', 'installed'], ['piper', 'skipped'], ['python', 'skipped'], ['qwen-base', 'skipped']]);
  assert.deepEqual(seen.filter(s => s.startsWith('start:')), ['start:runtime']);
});

test('every installer receives the explicit confirmation', async () => {
  const plan = await computeSetupPlan(env());
  const got: unknown[] = [];
  const base = fakeInstallers([]);
  await runSetup({ plan, env: target, installers: {
    ...base,
    installRuntime: async o => { got.push(o.confirmed); return {}; }, installPiper: async o => { got.push(o.confirmed); return {}; },
    ensurePython: async o => { got.push(o.confirmed); return (await base.ensurePython(o)); }, installBase: async o => { got.push(o.confirmed); },
  } });
  assert.deepEqual(got, [true, true, true, true]);
});

test('Base model detection (read-only): a complete snapshot is installed; missing, partial, empty or dangling (interrupted download) are missing; VoiceDesign is separate', () => {
  const hf = mkdtempSync(join(tmpdir(), 'gs-hf-'));
  const snap = (repo: string, name: string) => join(hf, 'hub', `models--${repo.replace('/', '--')}`, 'snapshots', name);
  try {
    return (async () => {
      assert.equal(await baseModelStatus(hf), 'missing');
      mkdirSync(snap(QWEN_MODEL_ID, 'a'), { recursive: true }); writeFileSync(join(snap(QWEN_MODEL_ID, 'a'), 'config.json'), '{}');
      assert.equal(await baseModelStatus(hf), 'missing', 'config only');
      mkdirSync(join(snap(QWEN_MODEL_ID, 'a'), 'speech_tokenizer')); writeFileSync(join(snap(QWEN_MODEL_ID, 'a'), 'model.safetensors'), '');
      assert.equal(await baseModelStatus(hf), 'missing', 'empty weights');
      rmSync(join(snap(QWEN_MODEL_ID, 'a'), 'model.safetensors')); symlinkSync(join(hf, 'nowhere'), join(snap(QWEN_MODEL_ID, 'a'), 'model.safetensors'));
      assert.equal(await baseModelStatus(hf), 'missing', 'dangling link');
      rmSync(join(snap(QWEN_MODEL_ID, 'a'), 'model.safetensors')); writeFileSync(join(snap(QWEN_MODEL_ID, 'a'), 'model.safetensors'), 'weights');
      assert.equal(await baseModelStatus(hf), 'installed'); assert.equal(await designModelStatus(hf), 'missing', 'the Base cache is not the VoiceDesign cache');
      mkdirSync(join(snap(QWEN_DESIGN_MODEL_ID, 'b'), 'speech_tokenizer'), { recursive: true }); writeFileSync(join(snap(QWEN_DESIGN_MODEL_ID, 'b'), 'config.json'), '{}'); writeFileSync(join(snap(QWEN_DESIGN_MODEL_ID, 'b'), 'x.safetensors'), 'w');
      assert.equal(await designModelStatus(hf), 'installed');
    })().finally(() => rmSync(hf, { recursive: true, force: true }));
  } catch (error) { rmSync(hf, { recursive: true, force: true }); throw error; }
});

test('T47 (S16): setup never plans a system package, on any platform; the system voice is only a doctor hint', async () => {
  for (const [platform, target] of [['darwin', 'darwin-arm64'], ['linux', 'linux-x64'], ['win32', 'win32-x64']] as const) {
    const plan = await computeSetupPlan(env({ platform, target }));
    assert.equal([...plan.components, ...plan.actionable, ...plan.missing].some(c => /system|espeak|spd|speech|sapi/i.test(c.id)), false, platform);
    assert.equal(/apt install speech-dispatcher|espeak/.test(describeSetupPlan(plan)), false, platform);
  }
});
