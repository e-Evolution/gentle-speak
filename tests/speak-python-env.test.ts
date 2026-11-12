import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MLX_AUDIO_VERSION, MLX_IMPORT_CODE, PYTHON_INSTRUCTION, detectPythonTooling, ensurePythonEnv, findPython, makeWhich, pythonEnvStatus, type RunResult, type RunTool } from '../lib/speak-python-env.ts';
import { PYTHON_RECORD_FILE, resolveQwenPython } from '../lib/speak-voices-install.ts';
import { QWEN_PYTHON_FLAGS } from '../lib/speak-voices.ts';

// T44 (S15): the gentle-speak Python environment. Every tool is a fake (uv, python, pip); scratch lives under mkdtemp and is removed.
const roots: string[] = [];
test.afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tmp = () => { const root = mkdtempSync(join(tmpdir(), 'gs-pyenv-')); roots.push(root); const home = join(root, '.gentle-speak'); mkdirSync(home, { recursive: true }); return { root, home }; };
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

type Call = { command: string; args: string[]; env?: NodeJS.ProcessEnv };
/** A fake toolbox: `uv venv` and `python -m venv` create the interpreter file; pip installs succeed; the import prints the version. */
function toolbox(o: { versions?: Record<string, string>; failVenv?: boolean; failUvVenv?: boolean; failInstall?: boolean; failImport?: boolean; mlx?: string } = {}) {
  const calls: Call[] = [];
  const run: RunTool = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const venvAt = (dir: string) => { mkdirSync(join(dir, 'bin'), { recursive: true }); writeFileSync(join(dir, 'bin', 'python'), '#!fake\n'); };
    if (command.endsWith('/uv')) {
      if (args[0] === 'venv') { if (o.failUvVenv || o.failVenv) return { code: 1, stdout: '', stderr: 'No interpreter found for Python 3.12' }; venvAt(args[args.length - 1]); return ok(); }
      if (args[0] === 'pip') return o.failInstall ? { code: 1, stdout: '', stderr: 'resolution failed' } : ok();
    }
    if (args[0] === '-c' && args[1]?.includes('sys.version_info')) { const v = o.versions?.[command.split('/').pop()!]; return v ? ok(`${v}\n`) : { code: 1, stdout: '', stderr: 'no' }; }
    if (args[0] === '-m' && args[1] === 'venv') { if (o.failVenv) return { code: 1, stdout: '', stderr: 'ensurepip is not available' }; venvAt(args[2]); return ok(); }
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
  assert.deepEqual(t.calls.find(c => c.args[0] === 'venv'), { command: '/bin/uv', args: ['venv', '--python', '3.12', venv], env: { HOME: '/real', HF_HOME: '/real/hf' } });
  assert.deepEqual(t.calls.find(c => c.args[0] === 'pip')!.args, ['pip', 'install', '--python', py, `mlx-audio==${MLX_AUDIO_VERSION}`]);
  assert.equal(t.calls.some(c => c.args[0] === '-m'), false, 'no venv module when uv is present');
  assert.ok(steps.length >= 3, steps.join('|'));
});

test('without uv, python3 -m venv of a Python >= 3.10 is used (the newest candidate wins, 3.9 is refused) and pip installs the pin', async () => {
  const { home } = tmp();
  const t = toolbox({ versions: { python3: '3.9', 'python3.10': '3.10', 'python3.11': '3.11' } });
  const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['python3', 'python3.10', 'python3.11']), platform: 'darwin', env: {} });
  assert.equal(out.status, 'installed'); assert.equal(out.status === 'installed' && out.tool, 'venv');
  const made = t.calls.find(c => c.args[0] === '-m' && c.args[1] === 'venv')!;
  assert.equal(made.command, '/bin/python3.11'); assert.deepEqual(made.args, ['-m', 'venv', join(home, 'python')]);
  const install = t.calls.find(c => c.args[1] === 'pip')!;
  assert.equal(install.command, join(home, 'python', 'bin', 'python')); assert.deepEqual(install.args, ['-m', 'pip', 'install', '--disable-pip-version-check', `mlx-audio==${MLX_AUDIO_VERSION}`]);
});

test('neither uv nor a suitable Python: an instruction and a skip; nothing is created, no package command runs', async () => {
  const { home } = tmp();
  const t = toolbox({ versions: { python3: '3.9' } });
  const out = await ensurePythonEnv({ home, confirmed: true, run: t.run, which: whichOf(['python3']), platform: 'darwin', env: {} });
  assert.deepEqual(out, { status: 'skipped', instruction: PYTHON_INSTRUCTION });
  assert.match(PYTHON_INSTRUCTION, /uv/); assert.match(PYTHON_INSTRUCTION, /Python 3\.10/); assert.match(PYTHON_INSTRUCTION, /No instalo nada del sistema/);
  assert.equal(existsSync(join(home, 'python')), false); assert.equal(existsSync(join(home, PYTHON_RECORD_FILE)), false);
  assert.equal(t.calls.every(c => c.args[0] === '-c' && c.args[1].includes('sys.version_info')), true, 'only version probes ran');
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
  assert.deepEqual(record, { schema: 'gentle-speak.python/v1', python: py, mlxAudio: MLX_AUDIO_VERSION, created: now.toISOString() });
  assert.equal(statSync(join(home, 'python.json')).mode & 0o777, 0o600);
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
    assert.ok(installs[0].command.endsWith('/uv') ? installs[0].args.includes('--python') : installs[0].command.includes('/python/bin/python'), 'installs go to the venv');
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

test('uv that cannot provide 3.12 falls back to a system Python >= 3.10; if that fails too the failure names uv', async () => {
  const a = tmp(), t = toolbox({ failUvVenv: true, versions: { python3: '3.11' } });
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

test('findPython and makeWhich: PATH lookup without a shell, newest >= 3.10 only', async () => {
  const { root } = tmp();
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n', { mode: 0o755 }); writeFileSync(join(bin, 'notexec'), 'x', { mode: 0o644 });
  const which = makeWhich({ PATH: `${join(root, 'nope')}:${bin}` }, 'linux');
  assert.equal(which('uv'), join(bin, 'uv')); assert.equal(which('notexec'), undefined); assert.equal(which('missing'), undefined);
  const t = toolbox({ versions: { python3: '3.13', 'python3.12': '3.12' } });
  assert.deepEqual(await findPython({ which: whichOf(['python3', 'python3.12']), run: t.run }), { python: '/bin/python3', version: '3.13' });
  assert.equal(await findPython({ which: whichOf(['python3']), run: toolbox({ versions: { python3: '3.8' } }).run }), undefined);
});
