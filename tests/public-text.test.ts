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
// Shipped text (source under lib/, extensions/ and scripts/, plus CHANGELOG.md and README.md) carries no internal planning references.
import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Internal task ids (`T1`-`T99`), log ids (`L10`-`L999`) and review advisory ids (`R1-…`-`R4-…`), as whole words.
 * Deliberately not matched: single-digit `L1`-`L9` (too common in unrelated text), and letters glued to digits or
 * words on either side, such as the `T` of an ISO timestamp (`2026-11-17T10:00`) or a hex/base64 run, because `\b`
 * needs a non-word character around the id.
 */
export const INTERNAL_REFERENCE = /\b(?:T\d{1,2}|L\d{2,3})\b|\bR[1-4]-[a-z0-9]/;

/** Every file (repository-relative, sorted) under `dir`; node_modules and dot directories are skipped. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) out.push(...walk(path)); }
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

const shipped = [...walk('lib'), ...walk('extensions'), ...walk('scripts'), 'CHANGELOG.md', 'README.md'];

test('the reference pattern catches internal ids and leaves look-alikes alone', () => {
  for (const hit of ['(T45)', 'T61 (L118):', 'see L51', '(S8, L29 → L31)', 'R3-002: a home', 'T6.']) assert.match(hit, INTERNAL_REFERENCE, hit);
  for (const miss of ['2026-11-17T10:00:00Z', 'L1 cache', 'sha256:ab12T45cd', 'UTF8', 'T100', 'L1000', 'R5-001', 'MR3-001']) assert.doesNotMatch(miss, INTERNAL_REFERENCE, miss);
});

test('shipped source, CHANGELOG and README carry no internal task, log or review references', () => {
  assert.ok(shipped.includes('extensions/gentle-speak.ts') && shipped.includes('scripts/speak-qwen-worker.py'));
  const found: string[] = [];
  for (const file of shipped) {
    readFileSync(join(root, file), 'utf8').split('\n').forEach((line, index) => {
      const match = INTERNAL_REFERENCE.exec(line);
      if (match) found.push(`${file}:${index + 1}: ${match[0]}`);
    });
  }
  assert.deepEqual(found, []);
});
