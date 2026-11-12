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
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const manifest = JSON.parse(await read('package.json'));

test('THIRD_PARTY_NOTICES.md exists, ships in the package and records the espeak-ng GPL-3.0 note', async () => {
  const notices = await read('THIRD_PARTY_NOTICES.md');
  assert.ok(manifest.files.includes('THIRD_PARTY_NOTICES.md'));
  assert.match(notices, /espeak-ng/);
  assert.match(notices, /GPL-3\.0/);
  assert.match(notices, /sherpa-onnx\/issues\/3731/);
  assert.match(notices, /sherpa-onnx\/issues\/4053/);
  assert.match(notices, /does not redistribute/i);
  assert.match(notices, /Unverified/i);
});

test('README carries the architecture diagram and the required sections', async () => {
  const readme = await read('README.md');
  assert.match(readme, /```mermaid\n/);
  for (const heading of ['Supported engines', 'Dependencies', 'License']) assert.match(readme, new RegExp(`^## ${heading}`, 'm'), `missing section ${heading}`);
  assert.match(readme, /THIRD_PARTY_NOTICES\.md/);
});
