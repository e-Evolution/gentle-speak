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
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';

// T62: what the host OS genuinely lacks, named once. Tests about behaviour that exists on every OS inject the platform instead
// (`platform: 'darwin'`, see hermetic.ts); only a feature the host does not have skips, and the reason says which.

/** Windows has no POSIX permission bits: `stat().mode` reads 0o666/0o777 whatever mode was requested, and chmod only toggles read-only. */
export const POSIX_MODES = process.platform !== 'win32';
export const NO_POSIX_MODES = 'Windows has no POSIX permission bits (stat().mode reads 0o666/0o777 whatever was requested)';

/** Windows has no Unix domain socket paths for net.listen() (only \\.\pipe\ names), and no `ps`; the shared Qwen service needs both, and mlx-audio runs on macOS only. */
export const UNIX_SOCKETS = process.platform !== 'win32';
export const NO_UNIX_SOCKETS = 'Windows has no Unix domain socket paths for net.listen() and no ps; the shared Qwen service (mlx-audio, macOS only) needs them';

/** Windows has no executable permission bit: X_OK only checks that the file exists. */
export const EXEC_BIT = process.platform !== 'win32';
export const NO_EXEC_BIT = 'Windows has no executable permission bit (access X_OK only checks existence)';

/** Asserts `path`'s permission bits where the OS has them; on Windows it still asserts that the path exists. */
export function assertMode(path: string, expected: number, message?: string): void {
  const mode = statSync(path).mode & 0o777;
  if (POSIX_MODES) assert.equal(mode, expected, message);
}
