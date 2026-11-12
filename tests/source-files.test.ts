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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { COPYRIGHT, SPDX, headerProblems, sourceFiles } from './helpers/source-files.ts';

const TS = `/**\n * ${COPYRIGHT}\n * ${SPDX}\n */\nexport {};\n`;
const HASH = `# ${COPYRIGHT}\n# ${SPDX}\nprint(1)\n`;

test('T54 header walk: no git, every source under the four directories is found and checked', () => {
  const root = mkdtempSync(join(tmpdir(), 'gs-headers-'));
  try {
    for (const dir of ['extensions', 'lib', 'scripts', 'tests/helpers', 'tests/node_modules/x', 'docs']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'extensions/a.ts'), TS);
    writeFileSync(join(root, 'lib/b.ts'), TS);
    writeFileSync(join(root, 'scripts/c.py'), `#!/usr/bin/env python3\n${HASH}`);
    writeFileSync(join(root, 'scripts/d.mjs'), `#!/usr/bin/env node\n${TS}`);
    writeFileSync(join(root, 'scripts/notes.md'), 'no header needed');
    writeFileSync(join(root, 'tests/helpers/e.ts'), TS);
    writeFileSync(join(root, 'tests/node_modules/x/skip.ts'), 'not a source of ours');
    writeFileSync(join(root, 'docs/z.ts'), 'outside the four directories');
    assert.deepEqual(sourceFiles(root), ['extensions/a.ts', 'lib/b.ts', 'scripts/c.py', 'scripts/d.mjs', 'tests/helpers/e.ts']);
    assert.deepEqual(headerProblems(root), []);
    writeFileSync(join(root, 'lib/missing.ts'), 'export {};\n');
    writeFileSync(join(root, 'scripts/late.sh'), `${HASH}#!/bin/sh\n`);
    writeFileSync(join(root, 'tests/helpers/untracked-new.ts'), '// no header\n');
    assert.deepEqual(headerProblems(root), ['lib/missing.ts', 'scripts/late.sh (shebang not first)', 'tests/helpers/untracked-new.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
