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
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, posix, win32 } from 'node:path';
import { qwenPythonEnv } from './speak-qwen.ts';
import { ensurePrivateHome, withPrivateCwd } from './speak-qwen-service.ts';
import { PYTHON_RECORD_FILE, PYTHON_RECORD_SCHEMA, resolveQwenPython } from './speak-voices-install.ts';
import { QWEN_PYTHON_FLAGS } from './speak-voices.ts';

/**
 * T44 (S15): gentle-speak's own Python environment, `<sharedHome>/python` (a venv), with pinned mlx-audio. It never uses sudo and never touches the system
 * Python's site-packages: `uv venv` or `python -m venv` creates the environment and every package goes into it. The result is recorded in
 * `<sharedHome>/python.json`, which `resolveQwenPython` (T45) already reads.
 */
export const MLX_AUDIO_VERSION = '0.4.4';
/** What the worker needs on top of `mlx-audio` itself (the pinned package declares its own dependencies; this is only what it does not pull in). */
export const PYTHON_EXTRA_REQUIREMENTS: readonly string[] = Object.freeze([]);
export const PYTHON_REQUIREMENTS: readonly string[] = Object.freeze([`mlx-audio==${MLX_AUDIO_VERSION}`, ...PYTHON_EXTRA_REQUIREMENTS]);
/** The import the worker performs first; the environment is valid only when it succeeds under the worker's own flags. */
export const MLX_IMPORT_CODE = 'from mlx_audio.tts.utils import load_model';
export const PYTHON_ENV_DIR = 'python';
/** Disk size of the venv with mlx-audio 0.4.4 and its dependencies, measured 2026-11-12 on a real `uv` install (`du -sk`: 467 080 KiB). */
export const PYTHON_ENV_APPROX_BYTES = 467_080 * 1024;
export const PYTHON_ENV_SIZE_SOURCE = 'aprox., medido en una instalación real de mlx-audio 0.4.4 con uv';
export const MIN_PYTHON: readonly [number, number] = Object.freeze([3, 10]) as readonly [number, number];

/**
 * T61 (L118): `python -m venv`, `python -m pip` and the version probes run in isolated mode. `-I` (Python 3.4+, so every supported 3.10+) keeps the
 * current and script directories off `sys.path` and ignores `PYTHON*` variables and the user site-packages, so a planted `pip/` or `venv/` is never imported.
 * It is valid on 3.10, where `-P` does not exist yet; the import check keeps the worker's own `QWEN_PYTHON_FLAGS` (`-E -P`).
 */
export const PYTHON_TOOL_FLAGS: readonly string[] = Object.freeze(['-I']);
/** T61: `uv` never reads `uv.toml` or `[tool.uv]` (a project's, or any parent's): the flag on every call, and `UV_NO_CONFIG=1` in its environment. */
export const UV_NO_CONFIG_ARGS: readonly string[] = Object.freeze(['--no-config']);
const uvEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, UV_NO_CONFIG: '1' });
const VERSION_CODE = "import sys; print('%d.%d' % sys.version_info[:2])";

export interface RunResult { code: number | null; stdout: string; stderr: string }
/** `cwd` is the child's working directory; T61: without one the default runner uses a fresh private directory, never the caller's (the user's project). */
export type RunTool = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; cwd?: string }) => Promise<RunResult>;
const execTool = (command: string, args: string[], { env, timeoutMs, signal }: { env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }, cwd: string) => new Promise<RunResult>(resolve => {
  execFile(command, args, { cwd, env, timeout: timeoutMs, signal, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});
export const defaultRunTool: RunTool = (command, args, options) => options.cwd !== undefined ? execTool(command, args, options, options.cwd) : withPrivateCwd(cwd => execTool(command, args, options, cwd));
export type Which = (name: string) => string | undefined;
/** The first executable file called `name` on `PATH`; no shell, no execution. T61: relative and empty entries (`.`, `bin`, ``) are skipped, so the working directory never supplies uv or python. */
export const makeWhich = (env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Which => name => {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const absolute = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
  for (const dir of (env.PATH ?? '').split(delimiter).filter(entry => entry !== '' && absolute(entry))) for (const ext of exts) {
    const path = join(dir, name + ext);
    try { if (statSync(path).isFile()) { accessSync(path, constants.X_OK); return path; } } catch { /* not here */ }
  }
  return undefined;
};

export const PYTHON_INSTRUCTION = 'No encontré uv ni un Python 3.10 o superior para crear el entorno de Qwen. Instalá uno de los dos (por ejemplo `brew install python@3.12` o `brew install uv`) y volvé a ejecutar /speak → «Instalar todo». No instalo nada del sistema por vos.';

export type PythonTooling =
  | { kind: 'uv'; uv: string }
  | { kind: 'python'; python: string; version: string }
  | { kind: 'none'; instruction: string };

const parseVersion = (text: string): [number, number] | undefined => { const m = /^(\d+)\.(\d+)/.exec(text.trim()); return m ? [Number(m[1]), Number(m[2])] : undefined; };
const atLeast = (v: [number, number]) => v[0] > MIN_PYTHON[0] || (v[0] === MIN_PYTHON[0] && v[1] >= MIN_PYTHON[1]);
const CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'];

/** The newest `python3*` ≥ 3.10 on `PATH`, or undefined. */
export async function findPython({ which, run = defaultRunTool, cwd }: { which: Which; run?: RunTool; cwd?: string }): Promise<{ python: string; version: string } | undefined> {
  let best: { python: string; version: string; parsed: [number, number] } | undefined;
  for (const name of CANDIDATES) {
    const path = which(name);
    if (!path) continue;
    const out = await run(path, [...PYTHON_TOOL_FLAGS, '-c', VERSION_CODE], { timeoutMs: 10_000, cwd }).catch(() => undefined);
    const parsed = out?.code === 0 ? parseVersion(out.stdout) : undefined;
    if (parsed && atLeast(parsed) && (!best || parsed[0] > best.parsed[0] || (parsed[0] === best.parsed[0] && parsed[1] > best.parsed[1]))) best = { python: path, version: `${parsed[0]}.${parsed[1]}`, parsed };
  }
  return best ? { python: best.python, version: best.version } : undefined;
}

/** What would create the environment: uv when present (preferred), else a usable system Python, else instructions. */
export async function detectPythonTooling({ which, run = defaultRunTool, cwd }: { which: Which; run?: RunTool; cwd?: string }): Promise<PythonTooling> {
  const uv = which('uv');
  if (uv) return { kind: 'uv', uv };
  const python = await findPython({ which, run, cwd });
  return python ? { kind: 'python', ...python } : { kind: 'none', instruction: PYTHON_INSTRUCTION };
}

export const pythonEnvDir = (home: string) => join(home, PYTHON_ENV_DIR);
const interpreterOf = (home: string, platform: string = process.platform) => platform === 'win32' ? join(pythonEnvDir(home), 'Scripts', 'python.exe') : join(pythonEnvDir(home), 'bin', 'python');

/**
 * Installed when `resolveQwenPython` yields an interpreter that still exists (the T44 record, or the old manifest's python of an earlier install). Cheap:
 * nothing is run; `/speak doctor` runs the import.
 */
export async function pythonEnvStatus(home: string): Promise<{ state: 'installed' | 'missing'; python?: string }> {
  const python = resolveQwenPython(home);
  if (!python) return { state: 'missing' };
  return (await stat(python).then(info => info.isFile(), () => false)) ? { state: 'installed', python } : { state: 'missing' };
}

export type PythonEnvOutcome =
  | { status: 'installed'; python: string; version: string; tool: 'uv' | 'venv'; alreadyInstalled: boolean }
  | { status: 'skipped'; instruction: string }
  | { status: 'failed'; message: string };

export interface EnsurePythonOptions {
  home: string;
  /** Explicit caller confirmation, like every installer. */
  confirmed: boolean;
  run?: RunTool;
  which?: Which;
  /** The environment for the validation (HOME and HF_HOME real, like the worker); defaults to `qwenPythonEnv`. */
  env?: NodeJS.ProcessEnv;
  platform?: string;
  now?: () => Date;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
const VENV_MS = 5 * 60_000, INSTALL_MS = 30 * 60_000, IMPORT_MS = 120_000;
const tail = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f]/g, ' ').trim().split('\n').slice(-3).join(' ').replace(/\s+/g, ' ').slice(0, 200);

/** The validation: the worker's interpreter flags, real HOME and HF_HOME, the import the worker performs. Returns the installed mlx-audio version on success. */
export async function validatePythonEnv({ python, run = defaultRunTool, env, signal, cwd }: { python: string; run?: RunTool; env?: NodeJS.ProcessEnv; signal?: AbortSignal; cwd?: string }): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  const code = `${MLX_IMPORT_CODE}\nfrom importlib.metadata import version\nprint(version('mlx-audio'))`;
  const out = await run(python, [...QWEN_PYTHON_FLAGS, '-c', code], { env: env ?? qwenPythonEnv(), timeoutMs: IMPORT_MS, signal, cwd });
  if (out.code !== 0) return { ok: false, message: `la importación de mlx_audio falló (${tail(out.stderr) || `código ${out.code}`})` };
  return { ok: true, version: out.stdout.trim().split('\n').pop()!.trim() };
}

async function writeRecord(home: string, python: string, version: string, now: Date) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, PYTHON_RECORD_FILE), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ schema: PYTHON_RECORD_SCHEMA, python, mlxAudio: version, created: now.toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/**
 * Creates `<home>/python` (uv when present: `uv venv --no-config --python 3.12` and `uv pip install --no-config`; else `python3 -I -m venv` of a Python ≥ 3.10), installs the pinned
 * mlx-audio, validates the import under the worker flags and writes `python.json`. No suitable tool is an instruction (`skipped`), never a failure.
 * An existing environment that already validates is kept as is. Never sudo, never the system site-packages.
 */
export async function ensurePythonEnv(options: EnsurePythonOptions): Promise<PythonEnvOutcome> {
  if (options.confirmed !== true) throw new Error('Explicit caller confirmation is required.');
  const { home, signal, onProgress } = options;
  const run = options.run ?? defaultRunTool, which = options.which ?? makeWhich(), platform = options.platform ?? process.platform;
  const env = options.env ?? qwenPythonEnv();
  const now = options.now ?? (() => new Date());
  // An absolute home keeps every derived path absolute: a relative or dash-leading venv path would be read by uv or python as a different location or an option.
  if (typeof home !== 'string' || !isAbsolute(home) || home.includes('\0')) return { status: 'failed', message: 'la ruta de gentle-speak no es absoluta' };
  const python = interpreterOf(home, platform), venv = pythonEnvDir(home);
  // T61: every child below runs in the private home (`cwd`), never in the session's working directory, which may be a hostile project.
  try { ensurePrivateHome(home); } catch { return { status: 'failed', message: 'la carpeta de gentle-speak no es un directorio propio del usuario' }; }
  const cwd = home;
  try {
    const existing = await pythonEnvStatus(home);
    if (existing.state === 'installed') {
      const valid = await validatePythonEnv({ python: existing.python!, run, env, signal, cwd });
      // Only the pinned mlx-audio is reused: another version is brought to the pin below instead of being recorded as current.
      if (valid.ok && valid.version === MLX_AUDIO_VERSION) return { status: 'installed', python: existing.python!, version: valid.version, tool: 'venv', alreadyInstalled: true };
    }
    const tooling = await detectPythonTooling({ which, run, cwd });
    if (tooling.kind === 'none') return { status: 'skipped', instruction: tooling.instruction };
    let tool: 'uv' | 'venv' = tooling.kind === 'uv' ? 'uv' : 'venv';
    // A leftover venv (a failed earlier install, another Python) is completed in place only when its interpreter runs and is 3.10 or newer; otherwise it is rebuilt.
    let haveVenv = await stat(python).then(info => info.isFile(), () => false);
    let clear = false;
    if (haveVenv) {
      const probe = await run(python, [...PYTHON_TOOL_FLAGS, '-c', VERSION_CODE], { env, timeoutMs: 10_000, signal, cwd }).catch(() => undefined);
      const parsed = probe?.code === 0 ? parseVersion(probe.stdout) : undefined;
      if (!parsed || !atLeast(parsed)) { haveVenv = false; clear = true; }
    }
    const createWith = async (how: PythonTooling): Promise<string | undefined> => {
      if (how.kind === 'uv') {
        onProgress?.('Creando el entorno con uv…');
        const made = await run(how.uv, ['venv', ...UV_NO_CONFIG_ARGS, ...(clear ? ['--clear'] : []), '--python', '3.12', venv], { env: uvEnv(env), timeoutMs: VENV_MS, signal, cwd });
        return made.code === 0 ? undefined : `uv no pudo crear el entorno (${tail(made.stderr) || `código ${made.code}`})`;
      }
      if (how.kind === 'python') {
        onProgress?.(`Creando el entorno con Python ${how.version}…`);
        const made = await run(how.python, [...PYTHON_TOOL_FLAGS, '-m', 'venv', ...(clear ? ['--clear'] : []), venv], { env, timeoutMs: VENV_MS, signal, cwd });
        return made.code === 0 ? undefined : `python -m venv no pudo crear el entorno (${tail(made.stderr) || `código ${made.code}`})`;
      }
      return 'no hay herramienta para crear el entorno';
    };
    if (!haveVenv) {
      let failure = await createWith(tooling);
      if (failure && tooling.kind === 'uv') {
        // uv could not provide a 3.12 (offline, unsupported): a system Python ≥ 3.10 is the documented second choice.
        const system = await findPython({ which, run, cwd });
        if (system) { tool = 'venv'; failure = await createWith({ kind: 'python', ...system }); }
      }
      if (failure) return { status: 'failed', message: failure };
    }
    onProgress?.(`Instalando mlx-audio ${MLX_AUDIO_VERSION}…`);
    const install = tool === 'uv' && tooling.kind === 'uv'
      ? await run(tooling.uv, ['pip', 'install', ...UV_NO_CONFIG_ARGS, '--python', python, ...PYTHON_REQUIREMENTS], { env: uvEnv(env), timeoutMs: INSTALL_MS, signal, cwd })
      : await run(python, [...PYTHON_TOOL_FLAGS, '-m', 'pip', 'install', '--disable-pip-version-check', ...PYTHON_REQUIREMENTS], { env, timeoutMs: INSTALL_MS, signal, cwd });
    if (install.code !== 0) return { status: 'failed', message: `no pude instalar mlx-audio (${tail(install.stderr) || `código ${install.code}`})` };
    onProgress?.('Validando mlx_audio…');
    const valid = await validatePythonEnv({ python, run, env, signal, cwd });
    if (!valid.ok) return { status: 'failed', message: valid.message };
    if (valid.version !== MLX_AUDIO_VERSION) return { status: 'failed', message: `se instaló mlx-audio ${valid.version || 'desconocido'} en lugar de ${MLX_AUDIO_VERSION}` };
    await writeRecord(home, python, valid.version, now());
    return { status: 'installed', python, version: valid.version, tool, alreadyInstalled: false };
  } catch (error) {
    return { status: 'failed', message: signal?.aborted ? 'cancelado' : tail(String((error as Error)?.message ?? 'error')) };
  }
}
