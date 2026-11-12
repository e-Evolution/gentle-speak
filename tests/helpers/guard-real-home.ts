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
// T35 (S5, S12) test guard: THE SUITE MUST NEVER TOUCH THE REAL USER'S AGENT OR SPEAK PATHS.
// Rule: any read or write under the account's real home (`os.userInfo().homedir`, never `$HOME`) in `.gentle-dot`, `.gentle-speak`,
// `.gentle-shell` or `.pi` throws before the call runs, is recorded with its stack, and fails the process at exit even when
// production code swallows the error. Tests must inject hermetic homes and dirs (tests/helpers/hermetic.ts), including `realHome`.
// Loaded twice on purpose: `--import` from the `test` script, and a top-of-file import in every test file (plain `node --test` is protected too).
// There are no real-path allowlist entries; `allowRealRead` exists for a future read-only real check and must be justified where used.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs'); // the mutable CJS object; the ESM namespace is read-only
const KEY = Symbol.for('gentle-speak.guard-real-home');
const REAL_HOME = os.userInfo().homedir;
const ROOTS = ['.gentle-dot', '.gentle-speak', '.gentle-shell', '.pi'].map(name => join(REAL_HOME, name));
const allowed = new Set<string>();
const violations: string[] = [];
export const realHomeForGuard = REAL_HOME;

/** Returns and clears the recorded violations (only the guard's own self-test may call this; a leak elsewhere must fail the run). */
export function takeViolations(): string[] { return violations.splice(0); }

/** Read-only exemption for one exact real path. Never allows writes. */
export function allowRealRead(path: string): void { allowed.add(resolve(path)); }

const WRITE = ['writeFile', 'appendFile', 'rename', 'copyFile', 'cp', 'mkdir', 'rm', 'rmdir', 'unlink', 'symlink', 'link', 'truncate', 'chmod', 'chown', 'utimes', 'mkdtemp', 'createWriteStream', 'open', 'opendir', 'lchmod'];
const READ = ['readFile', 'readdir', 'exists', 'stat', 'lstat', 'access', 'readlink', 'realpath', 'createReadStream', 'open', 'opendir', 'statfs', 'cp'];

const toPath = (arg: unknown): string | undefined => {
  try {
    if (typeof arg === 'string') return resolve(arg);
    if (arg instanceof URL) return fileURLToPath(arg);
    if (Buffer.isBuffer(arg)) return resolve(arg.toString());
  } catch { /* not a path */ }
  return undefined;
};
const protectedPath = (path: string) => ROOTS.some(root => path === root || path.startsWith(root + sep));

function check(name: string, write: boolean, args: unknown[]) {
  for (const arg of args.slice(0, 2)) {
    const path = toPath(arg);
    if (!path || !protectedPath(path)) continue;
    if (!write && allowed.has(path)) continue;
    const error = new Error(`guard-real-home: ${write ? 'write' : 'read'} of real user path blocked: fs.${name}(${path})`);
    violations.push(error.stack ?? error.message);
    throw error;
  }
}

const g = globalThis as Record<symbol, unknown>;
if (!g[KEY]) {
  g[KEY] = true;
  const wrap = (target: Record<string, any>, base: string, suffixes: string[]) => {
    const isWrite = WRITE.includes(base), isRead = READ.includes(base);
    for (const suffix of suffixes) {
      const name = base + suffix;
      const original = target[name];
      if (typeof original !== 'function') continue;
      const exempt = !isWrite && isRead; // open/opendir/cp count as writes (isWrite wins)
      target[name] = function (this: unknown, ...args: unknown[]) {
        check(name, isWrite && !exempt, args);
        return Reflect.apply(original, this, args);
      };
    }
  };
  for (const base of new Set([...WRITE, ...READ])) wrap(fs as any, base, base === 'exists' ? ['', 'Sync'] : base.startsWith('create') ? [''] : ['', 'Sync']);
  for (const base of new Set([...WRITE, ...READ])) if (!base.startsWith('create') && base !== 'exists') wrap(fs.promises as any, base, ['']);
  syncBuiltinESMExports();
  process.on('exit', () => {
    if (!violations.length) return;
    process.stderr.write(`\nguard-real-home: ${violations.length} blocked access(es) to the real user home:\n${violations.join('\n---\n')}\n`);
    process.exitCode = 1;
  });
}
