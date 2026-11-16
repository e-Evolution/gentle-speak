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
// Maintainer tool, not shipped in the npm package: regenerates scripts/requirements-qwen.txt, the hash-locked Python requirements the Qwen
// environment installs with `--require-hashes`. Usage: `npm run lock:qwen [-- --constraints <file>]`. Needs uv and network access to PyPI.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(root, 'scripts', 'requirements-qwen.txt');
const HEADER = [
  '# Qwen3-TTS Python environment for gentle-speak, installed with --require-hashes.',
  '# Regenerate with: npm run lock:qwen (see CONTRIBUTING.md). Do not edit by hand.',
];

function fail(message) {
  console.error(`lock:qwen: ${message}`);
  process.exit(1);
}

// The pinned mlx-audio version is the one the code validates after installing.
const source = readFileSync(join(root, 'lib', 'speak-python-env.ts'), 'utf8');
const version = /export const MLX_AUDIO_VERSION = '([^']+)'/.exec(source)?.[1];
if (!version) fail('MLX_AUDIO_VERSION not found in lib/speak-python-env.ts');

// Optional constraints (for example the package versions of a known-good environment), resolved from the directory npm was started in.
const args = process.argv.slice(2);
let constraints;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--constraints' && args[i + 1]) constraints = resolve(process.env.INIT_CWD ?? process.cwd(), args[++i]);
  else fail(`unknown argument: ${args[i]} (usage: npm run lock:qwen [-- --constraints <file>])`);
}

// uv runs from a private scratch directory with --no-config and UV_NO_CONFIG=1, so no uv.toml or pyproject.toml changes the result.
const scratch = mkdtempSync(join(tmpdir(), 'gentle-speak-lock-'));
try {
  const input = join(scratch, 'requirements-qwen.in');
  writeFileSync(input, `mlx-audio==${version}\n`);
  const compileArgs = ['pip', 'compile', '--no-config', input, ...(constraints ? ['-c', constraints] : []), '--universal', '--python-version', '3.12', '--generate-hashes', '--no-header', '--no-annotate'];
  let output;
  try {
    output = execFileSync('uv', compileArgs, { cwd: scratch, env: { ...process.env, UV_NO_CONFIG: '1' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    fail(`uv pip compile failed (${error.code === 'ENOENT' ? 'uv is not on PATH' : `exit ${error.status}`})`);
  }
  const body = output.replace(/\r\n/g, '\n').trimEnd();
  if (!new RegExp(`^mlx-audio==${version.replace(/\./g, '\\.')} `, 'm').test(body)) fail(`the result does not pin mlx-audio==${version}`);
  if (!/--hash=sha256:[0-9a-f]{64}/.test(body)) fail('the result has no sha256 hashes');
  const temporary = `${LOCK}.${process.pid}.tmp`;
  writeFileSync(temporary, `${HEADER.join('\n')}\n${body}\n`);
  renameSync(temporary, LOCK);
  const packages = body.split('\n').filter(line => /^[A-Za-z0-9]/.test(line)).length, hashes = (body.match(/--hash=sha256:/g) ?? []).length;
  console.log(`lock:qwen: wrote scripts/requirements-qwen.txt (${packages} packages, ${hashes} hashes)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
