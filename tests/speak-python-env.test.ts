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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEC_BIT, assertMode } from './helpers/platform.ts';
import { test } from 'node:test';
import { MIN_PYTHON, MLX_AUDIO_VERSION, MLX_IMPORT_CODE, PYTHON_INSTRUCTION, PYTHON_TOOL_FLAGS, defaultRunTool, detectPythonTooling, ensurePythonEnv, findPython, makeWhich, pythonEnvStatus, type RunResult, type RunTool } from '../lib/speak-python-env.ts';
import { PYTHON_RECORD_FILE, resolveQwenPython } from '../lib/speak-voices-install.ts';
import { QWEN_PYTHON_FLAGS } from '../lib/speak-voices.ts';

// T44 (S15): the gentle-speak Python environment. Every tool is a fake (uv, python, pip); scratch lives under mkdtemp and is removed.
const roots: string[] = [];
test.afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = () => { const root = mkdtempSync(join(tmpdir(), 'gs-pyenv-')); roots.push(root); const home = join(root, '.gentle-speak'); mkdirSync(home, { recursive: true }); return { root, home }; };
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
/** T63: the hash-locked requirements every install uses, resolved from the package (never process.cwd()), and its sha256 as recorded in python.json. */
const LOCK = fileURLToPath(new URL('../scripts/requirements-qwen.txt', import.meta.url));
const LOCK_SHA = createHash('sha256').update(readFileSync(LOCK)).digest('hex');

type Call = { command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string };
/** A fake toolbox: `uv venv` and `python -m venv` create the interpreter file; pip installs succeed; the import prints the version. */
function toolbox(o: { versions?: Record<string, string>; failVenv?: boolean; failUvVenv?: boolean; failInstall?: boolean; failImport?: boolean; mlx?: string } = {}) {
  const calls: Call[] = [];
  const run: RunTool = async (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env, cwd: options.cwd });
    if (args[0] === '-I') args = args.slice(1); // T61: the isolated-mode flag precedes -c / -m; the fake answers by what follows it
    const venvAt = (dir: string) => { mkdirSync(join(dir, 'bin'), { recursive: true }); writeFileSync(join(dir, 'bin', 'python'), '#!fake\n'); };
    if (command.endsWith('/uv')) {
      if (args[0] === 'venv') { if (o.failUvVenv || o.failVenv) return { code: 1, stdout: '', stderr: 'No interpreter found for Python 3.12' }; venvAt(args[args.length - 1]); return ok(); }
      if (args[0] === 'pip') return o.failInstall ? { code: 1, stdout: '', stderr: 'resolution failed' } : ok();
    }
    if (args[0] === '-c' && args[1]?.includes('sys.version_info')) { const v = o.versions?.[command.split(/[\\/]/).pop()!]; return v ? ok(`${v}\n`) : { code: 1, stdout: '', stderr: 'no' }; }
    if (args[0] === '-m' && args[1] === 'venv') { if (o.failVenv) return { code: 1, stdout: '', stderr: 'ensurepip is not available' }; venvAt(args[args.length - 1]); return ok(); }
    if (args[0] === '-m' && args[1] === 'pip') return o.failInstall ? { code: 1, stdout: '', stderr: 'no matching distribution' } : ok();
    if (args.includes('-c') && args.join(' ').includes('load_model')) return o.failImport ? { code: 1, stdout: '', stderr: 'ModuleNotFoundError: mlx' } : ok(`${o.mlx ?? MLX_AUDIO_VERSION}\n`);
    return { code: 127, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` };
  };
  return { run, calls };
}
const whichOf = (names: string[]) => (name: string) => names.includes(name) ? `/bin/${name}` : undefined;

test('uv is preferred over venv: uv venv --python 3.12, uv pip install the pinned package, no python -m venv', async () => {
  const { home } = tmp();
  const t = toolbox({ versions: { python3: '3.12' } });
  const steps: string[] = [];
  const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['uv', 'python3']), platform: 'darwin', env: { HOME: '/real', HF_HOME: '/real/hf' }, onProgress: m => steps.push(m) });
  assert.equal(out.status, 'installed'); assert.equal(out.status === 'installed' && out.tool, 'uv');
  const venv = join(home, 'python'), py = join(venv, 'bin', 'python');
  assert.deepEqual(t.calls.find(c => c.args[0] === 'venv'), { command: '/bin/uv', args: ['venv', '--no-config', '--python', '3.12', venv], env: { HOME: '/real', HF_HOME: '/real/hf', UV_NO_CONFIG: '1' }, cwd: home });
  assert.deepEqual(t.calls.find(c => c.args[0] === 'pip')!.args, ['pip', 'install', '--no-config', '--python', py, '--require-hashes', '-r', LOCK]);
  assert.equal(t.calls.some(c => c.args.includes('-m')), false, 'no venv module when uv is present');
  assert.ok(steps.length >= 3, steps.join('|'));
});

test('without uv, python3 -m venv of a Python >= 3.12 is used (the newest candidate wins, 3.11 is refused) and pip installs the lock', async () => {
  const { home } = tmp();
  const t = toolbox({ versions: { python3: '3.11', 'python3.11': '3.11', 'python3.12': '3.12' } });
  const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['python3', 'python3.11', 'python3.12']), platform: 'darwin', env: {} });
  assert.equal(out.status, 'installed'); assert.equal(out.status === 'installed' && out.tool, 'venv');
  const made = t.calls.find(c => c.args[1] === '-m' && c.args[2] === 'venv')!;
  assert.equal(made.command, '/bin/python3.12'); assert.deepEqual(made.args, ['-I', '-m', 'venv', join(home, 'python')]);
  const install = t.calls.find(c => c.args[2] === 'pip')!;
  assert.equal(install.command, join(home, 'python', 'bin', 'python')); assert.deepEqual(install.args, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '-r', LOCK]);
});

test('neither uv nor a suitable Python: an instruction and a skip; nothing is created, no package command runs', async () => {
  const { home } = tmp();
  const t = toolbox({ versions: { python3: '3.9' } });
  const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['python3']), platform: 'darwin', env: {} });
  assert.deepEqual(out, { status: 'skipped', instruction: PYTHON_INSTRUCTION });
  assert.match(PYTHON_INSTRUCTION, /uv/); assert.match(PYTHON_INSTRUCTION, /Python 3\.12/); assert.match(PYTHON_INSTRUCTION, /No instalo nada del sistema/);
  assert.equal(existsSync(join(home, 'python')), false); assert.equal(existsSync(join(home, PYTHON_RECORD_FILE)), false);
  assert.equal(t.calls.every(c => c.args[0] === '-I' && c.args[1] === '-c' && c.args[2].includes('sys.version_info')), true, 'only version probes ran');
  assert.deepEqual(await detectPythonTooling({ which: whichOf([]), run: t.run }), { kind: 'none', instruction: PYTHON_INSTRUCTION });
});

test('python.json is written (schema gentle-speak.python/v1, mode 0600) and resolveQwenPython reads it', async () => {
  const { home } = tmp();
  const t = toolbox();
  const now = new Date('2026-11-12T10:00:00.000Z');
  const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['uv']), platform: 'darwin', env: {}, now: () => now });
  const py = join(home, 'python', 'bin', 'python');
  assert.equal(out.status === 'installed' && out.python, py);
  const record = JSON.parse(readFileSync(join(home, 'python.json'), 'utf8'));
  assert.deepEqual(record, { schema: 'gentle-speak.python/v1', python: py, mlxAudio: MLX_AUDIO_VERSION, lockSha256: LOCK_SHA, created: now.toISOString() });
  assertMode(join(home, 'python.json'), 0o600);
  assert.equal(resolveQwenPython(home), py);
  assert.deepEqual((await pythonEnvStatus(home)), { state: 'installed', python: py });
  assert.deepEqual(readdirSync(home).filter(n => n.endsWith('.tmp')), [], 'no temp file left behind');
});

test('the import is validated under -E -P with the real HOME and HF_HOME that were passed, using the worker import', async () => {
  const { home } = tmp();
  const t = toolbox();
  const env = { HOME: '/real-user', HF_HOME: '/real-user/.cache/huggingface', HF_HUB_OFFLINE: '1' };
  await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['uv']), platform: 'darwin', env });
  const check = t.calls.find(c => c.args.join(' ').includes('load_model'))!;
  assert.deepEqual(check.args.slice(0, QWEN_PYTHON_FLAGS.length), [...QWEN_PYTHON_FLAGS]); assert.deepEqual([...QWEN_PYTHON_FLAGS], ['-E', '-P']);
  assert.ok(check.args.join(' ').includes(MLX_IMPORT_CODE)); assert.equal(MLX_IMPORT_CODE, 'from mlx_audio.tts.utils import load_model');
  assert.equal(check.env!.HOME, '/real-user'); assert.equal(check.env!.HF_HOME, '/real-user/.cache/huggingface');
});

test('never sudo, never the system site-packages: only the venv interpreter or uv installs', async () => {
  for (const path of [['uv'], ['python3.12']]) {
    const t = toolbox({ versions: { 'python3.12': '3.12' } });
    await ensurePythonEnv({ home: tmp().home, confirmed: true, run: t.run, which: whichOf(path), platform: 'darwin', env: {} });
    const words = t.calls.flatMap(c => [c.command, ...c.args]);
    for (const banned of ['sudo', '--system', '--user', '--break-system-packages', '--target']) assert.equal(words.includes(banned), false, banned);
    const installs = t.calls.filter(c => c.args.includes('install'));
    assert.equal(installs.length, 1);
    assert.ok(installs[0].command.endsWith('/uv') ? installs[0].args.includes('--python') : installs[0].command.includes(join('python', 'bin', 'python')), 'installs go to the venv');
  }
});

test('a failed install or a failed import is a failure with no python.json', async () => {
  for (const [name, o, pattern] of [['install', { failInstall: true }, /no pude instalar mlx-audio/], ['import', { failImport: true }, /la importación de mlx_audio falló/]] as const) {
    const { home } = tmp();
    const t = toolbox(o);
    const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['uv']), platform: 'darwin', env: {} });
    assert.equal(out.status, 'failed', name); assert.match(out.status === 'failed' ? out.message : '', pattern);
    assert.equal(existsSync(join(home, PYTHON_RECORD_FILE)), false, name); assert.equal(resolveQwenPython(home), undefined, name);
  }
});

test('uv that cannot provide 3.12 falls back to a system Python >= 3.12; if that fails too the failure names uv', async () => {
  const a = tmp(), t = toolbox({ failUvVenv: true, versions: { python3: '3.12' } });
  const out = await ensurePythonEnv({ home: a.home, confirmed: true, run: t.run, which: whichOf(['uv', 'python3']), platform: 'darwin', env: {} });
  assert.equal(out.status === 'installed' && out.tool, 'venv');
  const b = tmp(), u = toolbox({ failUvVenv: true });
  const bad = await ensurePythonEnv({ home: b.home, confirmed: true, run: u.run, which: whichOf(['uv']), platform: 'darwin', env: {} });
  assert.equal(bad.status, 'failed'); assert.match(bad.status === 'failed' ? bad.message : '', /uv no pudo crear el entorno/);
});

test('an existing environment that already validates is kept as is (nothing is created or installed again)', async () => {
  const { home } = tmp();
  const first = toolbox();
  await ensurePythonEnv({ home, confirmed: true, run: first.run, which: whichOf(['uv']), platform: 'darwin', env: {} });
  const second = toolbox();
  const out = await ensurePythonEnv({ home, confirmed: true, run: second.run, which: whichOf(['uv']), platform: 'darwin', env: {} });
  assert.equal(out.status === 'installed' && out.alreadyInstalled, true);
  assert.deepEqual(second.calls.filter(c => c.args[0] === 'venv' || c.args.includes('install')), []);
});

test('an explicit confirmation is required and nothing runs without it', async () => {
  const { home } = tmp(); const t = toolbox();
  await assert.rejects(() => ensurePythonEnv({ home, confirmed: false, run: t.run, which: whichOf(['uv']) }), /confirmation/i);
  assert.deepEqual(t.calls, []);
});

test('findPython and makeWhich: PATH lookup without a shell, newest >= 3.12 only', async () => {
  const { root } = tmp();
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n', { mode: 0o755 }); writeFileSync(join(bin, 'notexec'), 'x', { mode: 0o644 });
  const which = makeWhich({ PATH: [join(root, 'nope'), bin].join(delimiter) }, process.platform);
  assert.equal(which('uv'), join(bin, 'uv')); if (EXEC_BIT) assert.equal(which('notexec'), undefined); assert.equal(which('missing'), undefined);
  const t = toolbox({ versions: { python3: '3.13', 'python3.12': '3.12' } });
  assert.deepEqual(await findPython({ which: whichOf(['python3', 'python3.12']), run: t.run }), { python: '/bin/python3', version: '3.13' });
  assert.equal(await findPython({ which: whichOf(['python3']), run: toolbox({ versions: { python3: '3.8' } }).run }), undefined);
});

test('T49 R1-001: a home that is not an absolute path is refused before anything runs (no relative or option-like venv path reaches uv or python)', async () => {
  for (const home of ['relative/home', '-x', '']) {
    const t = toolbox();
    const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['uv']), platform: 'darwin', env: {} });
    assert.equal(out.status, 'failed'); assert.match(out.status === 'failed' ? out.message : '', /ruta/);
    assert.deepEqual(t.calls, [], `nothing ran for ${JSON.stringify(home)}`);
  }
});

test('T49 R1-001: an existing environment with another mlx-audio version is not reused; the pin is installed and validated again', async () => {
  const { home } = tmp();
  await ensurePythonEnv({ home, confirmed: true, run: toolbox().run, which: whichOf(['uv']), platform: 'darwin', env: {} });
  const base = toolbox(); let installed = false;
  const run: RunTool = async (command, args, options) => {
    if (args[0] === 'pip') installed = true;
    if (args.join(' ').includes('load_model')) { base.calls.push({ command, args }); return ok(`${installed ? MLX_AUDIO_VERSION : '0.4.3'}\n`); }
    return base.run(command, args, options);
  };
  const out = await ensurePythonEnv({ home, confirmed: true, run, which: whichOf(['uv']), platform: 'darwin', env: {} });
  assert.equal(out.status, 'installed'); assert.equal(out.status === 'installed' && out.alreadyInstalled, false);
  assert.equal(out.status === 'installed' && out.version, MLX_AUDIO_VERSION);
  assert.equal(base.calls.some(c => c.args[0] === 'pip'), true, 'the pinned package was installed');
  assert.equal(JSON.parse(readFileSync(join(home, 'python.json'), 'utf8')).mlxAudio, MLX_AUDIO_VERSION);
});

test('T49 R3-venv-pip-reuse: a leftover venv from a failed install whose interpreter is broken or older than 3.12 is recreated with --clear, not pip-installed into', async () => {
  for (const [tooling, versions] of [['uv', {}], ['uv', { python: '3.9' }], ['uv', { python: '3.11' }], ['python3', {}], ['python3', { python: '3.11', python3: '3.12' }]] as const) {
    const { home } = tmp();
    const which = whichOf(tooling === 'uv' ? ['uv'] : ['python3']);
    const first = await ensurePythonEnv({ home, confirmed: true, run: toolbox({ failInstall: true, versions: { python3: '3.12' } }).run, which, platform: 'darwin', env: {} });
    assert.equal(first.status, 'failed');
    const t = toolbox({ versions: { python3: '3.12', ...versions } });
    const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which, platform: 'darwin', env: {} });
    assert.equal(out.status, 'installed', JSON.stringify(out));
    const made = t.calls.find(c => c.args[0] === 'venv' || c.args.join(' ').includes('-m venv'));
    assert.ok(made, `recreated (${tooling}, ${JSON.stringify(versions)})`); assert.ok(made.args.includes('--clear'));
    assert.ok(t.calls.findIndex(c => c === made) < t.calls.findIndex(c => c.args.includes('install')), 'recreated before installing');
  }
});

test('T49 R3-venv-pip-reuse: a leftover venv with a healthy 3.12+ interpreter is completed in place (no --clear)', async () => {
  const { home } = tmp();
  const which = whichOf(['uv']);
  await ensurePythonEnv({ home, confirmed: true, run: toolbox({ failInstall: true }).run, which, platform: 'darwin', env: {} });
  const t = toolbox({ versions: { python: '3.12' } });
  const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which, platform: 'darwin', env: {} });
  assert.equal(out.status, 'installed');
  assert.equal(t.calls.some(c => c.args[0] === 'venv'), false); assert.equal(t.calls.some(c => c.args.includes('install')), true);
});

// ---- T61 (S15, L118): a hostile project directory must not steer the install (uv.toml, a planted pip/ or venv/ package) ----
/** Runs `work` with `process.cwd()` set to `dir`, restoring it afterwards. */
async function inside<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try { return await work(); } finally { process.chdir(before); }
}
/** A hostile checkout: `uv.toml` with a bogus index (and a field uv refuses, so reading it is visible offline), `pip/` and `venv/` packages that write a marker. */
function hostileProject(root: string) {
  const project = join(root, 'project'), marker = join(root, 'HIJACKED');
  for (const pkg of ['pip', 'venv']) {
    mkdirSync(join(project, pkg), { recursive: true });
    const code = `open(${JSON.stringify(marker)}, "a").write(${JSON.stringify(pkg + '\n')})\n`;
    writeFileSync(join(project, pkg, '__init__.py'), ''); writeFileSync(join(project, pkg, '__main__.py'), code);
  }
  writeFileSync(join(project, 'uv.toml'), 'index-url = "http://attacker.invalid/simple"\nhijack-canary = true\n');
  return { project, marker };
}

test('T61: every install child (probes, venv, install, validation) runs in the shared home, never in process.cwd(); the home ends 0700', async () => {
  for (const [label, names, o] of [['uv', ['uv'], {}], ['venv', ['python3.12'], { versions: { 'python3.12': '3.12' } }], ['uv fallback', ['uv', 'python3.12'], { failUvVenv: true, versions: { 'python3.12': '3.12' } }]] as const) {
    const { root, home } = tmp();
    const { project } = hostileProject(root);
    const t = toolbox(o);
    const out = await inside(project, () => ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf([...names]), platform: 'darwin', env: {} }));
    assert.equal(out.status, 'installed', label);
    assert.ok(t.calls.length >= 3, label);
    for (const call of t.calls) {
      assert.equal(call.cwd, home, `${label}: ${call.command} ${call.args.join(' ')}`);
      assert.notEqual(call.cwd, process.cwd(), label);
    }
    assertMode(home, 0o700, label);
  }
});

test('T61: every uv invocation carries --no-config and UV_NO_CONFIG=1; the caller env is kept', async () => {
  for (const o of [{}, { failUvVenv: true, versions: { python3: '3.12' } }]) {
    const { home } = tmp();
    const t = toolbox(o);
    await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['uv', 'python3']), platform: 'darwin', env: { HOME: '/real', KEEP: 'yes' } });
    const uv = t.calls.filter(c => c.command.endsWith('/uv'));
    assert.ok(uv.length >= 1);
    for (const call of uv) {
      assert.ok(call.args.includes('--no-config'), call.args.join(' '));
      assert.equal(call.env?.UV_NO_CONFIG, '1'); assert.equal(call.env?.KEEP, 'yes'); assert.equal(call.env?.HOME, '/real');
    }
    for (const call of t.calls.filter(c => !c.command.endsWith('/uv'))) assert.equal(call.args.includes('--no-config'), false, 'only uv gets the uv flag');
  }
});

test('T61: python -m venv, python -m pip and the version probes run in isolated mode (-I) on 3.12 and on 3.13; the import check keeps the worker flags', async () => {
  assert.deepEqual([...PYTHON_TOOL_FLAGS], ['-I']);
  for (const version of ['3.12', '3.13']) {
    const { home } = tmp();
    const name = `python${version}`;
    const t = toolbox({ versions: { [name]: version, python: version } });
    const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf([name]), platform: 'darwin', env: {} });
    assert.equal(out.status, 'installed', version);
    const venv = t.calls.find(c => c.args.join(' ').includes('-m venv'))!, pip = t.calls.find(c => c.args.join(' ').includes('-m pip'))!;
    assert.deepEqual(venv.args.slice(0, 3), ['-I', '-m', 'venv'], version); assert.deepEqual(pip.args.slice(0, 3), ['-I', '-m', 'pip'], version);
    for (const probe of t.calls.filter(c => c.args.join(' ').includes('sys.version_info'))) assert.deepEqual(probe.args.slice(0, 2), ['-I', '-c'], version);
    assert.equal(t.calls.some(c => c.args.includes('-P') && !c.args.join(' ').includes('load_model')), false, `${version}: the tools use -I, not -P`);
    const check = t.calls.find(c => c.args.join(' ').includes('load_model'))!;
    assert.deepEqual(check.args.slice(0, 2), [...QWEN_PYTHON_FLAGS], 'the import check keeps -E -P');
  }
});

test('T61: makeWhich ignores relative and empty PATH entries (".", "bin", ""), so a project directory cannot shadow uv or python', async () => {
  const { root } = tmp();
  const make = (dir: string) => { mkdirSync(dir, { recursive: true }); for (const name of ['uv', 'python3']) writeFileSync(join(dir, name), '#!/bin/sh\n', { mode: 0o755 }); };
  make(join(root, 'bin')); make(join(root, 'trusted'));
  await inside(root, async () => {
    for (const PATH of ['.', 'bin', '', delimiter, ['.', 'bin', '', ''].join(delimiter)]) assert.equal(makeWhich({ PATH }, process.platform)('uv'), undefined, JSON.stringify(PATH));
    writeFileSync(join(root, 'uv'), '#!/bin/sh\n', { mode: 0o755 });
    const which = makeWhich({ PATH: ['.', 'bin', '', join(root, 'trusted')].join(delimiter) }, process.platform);
    assert.equal(which('uv'), join(root, 'trusted', 'uv')); assert.equal(which('python3'), join(root, 'trusted', 'python3'));
  });
  assert.equal(makeWhich({ PATH: 'bin;C:\\Python312' }, 'win32')('python'), undefined, 'win32: a relative entry is skipped and a missing absolute one finds nothing');
});

test('T61: defaultRunTool without a cwd runs the child in a fresh private directory (never process.cwd()) and removes it; with a cwd it uses that one', async () => {
  const { root, home } = tmp();
  const print = ['-e', 'process.stdout.write(process.cwd())'];
  const there = await inside(root, () => defaultRunTool(process.execPath, print, { timeoutMs: 10_000 }));
  assert.equal(there.code, 0);
  assert.notEqual(there.stdout, realpathSync(root)); assert.notEqual(there.stdout, realpathSync(process.cwd()));
  assert.equal(existsSync(there.stdout), false, 'the private directory is removed after the child exits');
  const given = await defaultRunTool(process.execPath, print, { timeoutMs: 10_000, cwd: home });
  assert.equal(given.stdout, realpathSync(home));
});

test('T61: hostile project regression: a planted pip/ or venv/ and a uv.toml in process.cwd() never run or steer the install (real python and uv, offline)', async () => {
  const { root, home } = tmp();
  const { project, marker } = hostileProject(root);
  const python = await findPython({ which: makeWhich() });
  const uv = makeWhich()('uv');
  // The fixture is live: a plain `python -m pip` / `python -m venv` started in the project imports the planted package (the L118 attack).
  if (python) {
    for (const mod of ['pip', 'venv']) { try { execFileSync(python.python, ['-m', mod, '--version'], { cwd: project, stdio: 'ignore', timeout: 30_000 }); } catch { /* the planted module is not a real tool */ } }
    assert.equal(readFileSync(marker, 'utf8').replace(/\r\n/g, '\n'), 'pip\nvenv\n', 'the planted packages run when the cwd is the project'); rmSync(marker);
  }
  // Offline and hermetic: pip may not use an index, uv may not download, and every cache lives in the scratch root.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, 'fake-home'), TMPDIR: process.env.TMPDIR, PIP_NO_INDEX: '1', PIP_CONFIG_FILE: '/dev/null', PIP_CACHE_DIR: join(root, 'pip-cache'),
    UV_OFFLINE: '1', UV_PYTHON_DOWNLOADS: 'never', UV_CACHE_DIR: join(root, 'uv-cache'), XDG_CACHE_HOME: join(root, 'xdg-cache'),
  };
  const seen: Array<{ command: string; args: string[]; cwd?: string; result: RunResult }> = [];
  const real: RunTool = async (command, args, options) => {
    if (args.join(' ').includes('load_model')) return { code: 1, stdout: '', stderr: 'ModuleNotFoundError: mlx_audio' }; // never imports a model
    const result = await defaultRunTool(command, args, options);
    seen.push({ command, args, cwd: options.cwd, result });
    return result;
  };
  // A uv stand-in for machines without uv: it honours ./uv.toml exactly as uv does (cwd and ancestors), unless --no-config or UV_NO_CONFIG.
  const fakeUvIndexes: string[] = [];
  const emulated: RunTool = async (command, args, options) => {
    seen.push({ command, args, cwd: options.cwd, result: ok() });
    const configured = !args.includes('--no-config') && options.env?.UV_NO_CONFIG !== '1' && existsSync(join(options.cwd ?? process.cwd(), 'uv.toml'));
    if (args[0] === 'pip') fakeUvIndexes.push(configured ? 'http://attacker.invalid/simple' : 'https://pypi.org/simple');
    if (args[0] === 'venv') { mkdirSync(join(args[args.length - 1], 'bin'), { recursive: true }); writeFileSync(join(args[args.length - 1], 'bin', 'python'), '#!fake\n'); }
    if (args.join(' ').includes('load_model')) return ok(`${MLX_AUDIO_VERSION}\n`);
    return ok();
  };
  await inside(project, async () => {
    const fake = await ensurePythonEnv({ home: join(root, 'emulated-home'), confirmed: true, run: emulated, which: whichOf(['uv']), platform: 'darwin', env });
    assert.equal(fake.status, 'installed');
    assert.deepEqual(fakeUvIndexes, ['https://pypi.org/simple'], 'the bogus index of ./uv.toml is never used');
    if (python) {
      const which = (name: string) => name === 'uv' ? undefined : makeWhich()(name);
      const out = await ensurePythonEnv({ home, confirmed: true, run: real, which, platform: process.platform, env });
      assert.equal(out.status, 'failed', 'offline: the install cannot complete'); // pip has no index; nothing was downloaded
      assert.ok(existsSync(join(home, 'python', 'pyvenv.cfg')), 'python -I -m venv really created the environment');
    }
    if (uv) {
      const uvHome = join(root, 'uv-home');
      await ensurePythonEnv({ home: uvHome, confirmed: true, run: real, which: name => name === 'uv' ? uv : undefined, platform: process.platform, env });
      for (const call of seen.filter(c => c.command === uv)) assert.doesNotMatch(call.result.stderr, /hijack-canary|uv\.toml|attacker/, `uv read the project config: ${call.args.join(' ')}`);
    }
  });
  assert.equal(existsSync(marker), false, 'no planted module ran');
  for (const call of seen) assert.notEqual(call.cwd, project, `${call.command} ${call.args.join(' ')} ran in the project`);
  assert.ok(seen.length > 0);
});

test('T63: Python 3.11 and 3.10 are refused and 3.12 is accepted: numpy in the lock needs 3.12 (and the worker\'s -P needs 3.11)', async () => {
  assert.deepEqual([...MIN_PYTHON], [3, 12]);
  assert.ok(QWEN_PYTHON_FLAGS.includes('-P'));
  for (const old of ['3.10', '3.11']) {
    const name = `python${old}`;
    const t = toolbox({ versions: { python3: old, [name]: old } });
    assert.equal(await findPython({ which: whichOf(['python3', name]), run: t.run }), undefined, old);
    const { home } = tmp();
    const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['python3', name]), platform: 'darwin', env: {} });
    assert.equal(out.status, 'skipped', `${old}: ${JSON.stringify(out)}`);
    assert.equal(t.calls.some(c => c.args.join(' ').includes('-m venv') || c.args.includes('install')), false, old);
    assert.equal(t.calls.some(c => c.command.endsWith('/python3.11')), false, `${old}: python3.11 is no longer a candidate`);
  }
  assert.deepEqual(await findPython({ which: whichOf(['python3']), run: toolbox({ versions: { python3: '3.12' } }).run }), { python: '/bin/python3', version: '3.12' });
  assert.match(PYTHON_INSTRUCTION, /3\.12 o superior/); assert.doesNotMatch(PYTHON_INSTRUCTION, /3\.11/);
});

// ---- T63 (S5, S15, L118, L124): the Qwen environment installs exactly the hash-locked requirements ----------------------------------------
test('T63: both install paths install the lock with --require-hashes -r <absolute lock path>; the bare mlx-audio spec is never passed', async () => {
  assert.ok(LOCK.endsWith(join('scripts', 'requirements-qwen.txt')) && LOCK === join(LOCK), 'absolute and normalized');
  for (const [label, names, o] of [['uv', ['uv'], {}], ['venv', ['python3.12'], { versions: { 'python3.12': '3.12' } }]] as const) {
    const { root, home } = tmp();
    const { project } = hostileProject(root);
    const t = toolbox(o);
    const out = await inside(project, () => ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf([...names]), platform: 'darwin', env: {} }));
    assert.equal(out.status, 'installed', label);
    const installs = t.calls.filter(c => c.args.includes('install'));
    assert.equal(installs.length, 1, label);
    const py = join(home, 'python', 'bin', 'python');
    assert.deepEqual(installs[0].args, label === 'uv' ? ['pip', 'install', '--no-config', '--python', py, '--require-hashes', '-r', LOCK] : ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--require-hashes', '-r', LOCK], label);
    for (const call of t.calls) assert.equal(call.args.some(arg => /^mlx-audio/.test(arg)), false, `${label}: ${call.args.join(' ')}`);
  }
});

test('T63: a missing or unreadable lock fails clearly before any installer (or any probe) runs', async () => {
  for (const names of [['uv'], ['python3.12']]) {
    const { root, home } = tmp();
    const t = toolbox({ versions: { 'python3.12': '3.12' } });
    for (const lockPath of [join(root, 'missing.txt'), root /* a directory: unreadable as a file */]) {
      const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(names), platform: 'darwin', env: {}, lockPath } as Parameters<typeof ensurePythonEnv>[0]);
      assert.equal(out.status, 'failed', lockPath);
      assert.match(out.status === 'failed' ? out.message : '', /requirements-qwen\.txt/);
    }
    assert.deepEqual(t.calls, [], 'nothing ran');
    assert.equal(existsSync(join(home, 'python')), false); assert.equal(existsSync(join(home, PYTHON_RECORD_FILE)), false);
  }
});

test('T63: the shipped lock pins exactly mlx-audio==0.4.4 and hashes every requirement; nothing is unpinned', () => {
  assert.equal(MLX_AUDIO_VERSION, '0.4.4');
  const lines = readFileSync(LOCK, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const requirements: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#') || /^\s+--hash=/.test(line)) continue;
    const name = line.split(/[=<>!~;\s\\[]/)[0];
    assert.match(line, /^[A-Za-z0-9._-]+(\[[^\]]+\])?==[^\s;\\]+( ; [^\\]+)? \\$/, `pinned with ==: ${line}`);
    assert.match(lines[i + 1] ?? '', /^\s+--hash=sha256:[0-9a-f]{64}( \\)?$/, `${name} is followed by a sha256 hash`);
    requirements.push(name.toLowerCase());
  }
  assert.ok(requirements.length >= 20, `${requirements.length} requirements`);
  assert.deepEqual(lines.filter(line => /^mlx-audio\b/.test(line)).map(line => line.split(' ')[0]), ['mlx-audio==0.4.4']);
  for (const line of lines.filter(line => /--hash=/.test(line))) assert.match(line, /^\s+--hash=sha256:[0-9a-f]{64}( \\)?$/, line);
  assert.equal(lines.some(line => /^\s*-(e|-index-url|-extra-index-url|f|-find-links|i)\b/.test(line)), false, 'no index or editable overrides');
});

test('T63: an environment recorded without the current lock sha (an old unlocked install, or another lock) is re-installed from the lock into the same venv', async () => {
  for (const [label, names, o, stale] of [
    ['uv, no lock recorded', ['uv'], {}, undefined],
    ['uv, another lock', ['uv'], {}, 'f'.repeat(64)],
    ['pip, no lock recorded', ['python3.12'], { versions: { 'python3.12': '3.12', python: '3.12' } }, undefined],
  ] as const) {
    const { home } = tmp();
    const first = await ensurePythonEnv({ home, confirmed: true, run: toolbox(o).run, which: whichOf([...names]), platform: 'darwin', env: {} });
    assert.equal(first.status, 'installed', label);
    const py = join(home, 'python', 'bin', 'python');
    assert.deepEqual(await pythonEnvStatus(home), { state: 'installed', python: py }, `${label}: current lock`);
    // The record an earlier (unlocked) release wrote, or one from another lock.
    writeFileSync(join(home, PYTHON_RECORD_FILE), JSON.stringify({ schema: 'gentle-speak.python/v1', python: py, mlxAudio: MLX_AUDIO_VERSION, created: '2026-11-01T00:00:00.000Z', ...(stale ? { lockSha256: stale } : {}) }));
    assert.deepEqual(await pythonEnvStatus(home), { state: 'missing', python: py, outdated: true }, label);
    const t = toolbox({ versions: { python: '3.12', 'python3.12': '3.12' } });
    const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf([...names]), platform: 'darwin', env: {} });
    assert.equal(out.status, 'installed', label); assert.equal(out.status === 'installed' && out.alreadyInstalled, false, label);
    assert.equal(t.calls.some(c => c.args[0] === 'venv' || c.args.join(' ').includes('-m venv')), false, `${label}: the venv is not recreated`);
    const install = t.calls.filter(c => c.args.includes('install'));
    assert.equal(install.length, 1, label); assert.deepEqual(install[0].args.slice(-3), ['--require-hashes', '-r', LOCK], label);
    assert.equal(JSON.parse(readFileSync(join(home, PYTHON_RECORD_FILE), 'utf8')).lockSha256, LOCK_SHA, label);
    assert.deepEqual(await pythonEnvStatus(home), { state: 'installed', python: py }, `${label}: current again`);
  }
});

test('T63: an interpreter from the old voices manifest (no python.json) is not ours to re-install: its status is unchanged', async () => {
  const { root, home } = tmp();
  const py = join(root, 'brew', 'bin', 'python3'); mkdirSync(join(root, 'brew', 'bin'), { recursive: true }); writeFileSync(py, '#!fake\n');
  mkdirSync(join(home, 'voices', 'qwen3'), { recursive: true });
  writeFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), JSON.stringify({ schema: 'gentle-speak.qwen-voices/v1', python: py, voices: {} }));
  assert.equal(resolveQwenPython(home), py);
  assert.deepEqual(await pythonEnvStatus(home), { state: 'installed', python: py });
});
