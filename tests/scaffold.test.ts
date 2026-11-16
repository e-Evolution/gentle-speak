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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

test('npm and Pi discover the inert extension entrypoint', async () => {
  assert.equal(manifest.name, '@e-evolution/gentle-speak');
  assert.deepEqual(manifest.publishConfig, { access: 'public' });
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.deepEqual(manifest.pi.extensions, ['./extensions/gentle-speak.ts']);
  assert.equal(manifest.pi.image, './assets/preview.png');
  assert.deepEqual(manifest.peerDependencies, {
    '@earendil-works/pi-coding-agent': '*',
    '@earendil-works/pi-tui': '*',
  });
  assert.ok(!manifest.dependencies?.['@earendil-works/pi-coding-agent']);
  assert.ok(!manifest.dependencies?.['@earendil-works/pi-tui']);
  assert.deepEqual(manifest.files, ['extensions/', 'lib/', 'scripts/', '!scripts/lock-qwen.mjs', 'assets/preview.png', 'assets/logo.svg', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']);
  assert.equal(manifest.scripts['lock:qwen'], 'node scripts/lock-qwen.mjs');
  assert.equal(manifest.scripts.test, 'node --experimental-strip-types --import ./tests/helpers/guard-real-home.ts --test --test-timeout=60000 tests/*.test.ts');
  assert.match(await readFile(new URL('extensions/gentle-speak.ts', root), 'utf8'), /export default function/);
});

test('package includes its stated license and instructions', async () => {
  assert.match(await readFile(new URL('LICENSE', root), 'utf8'), /MIT License/);
  assert.match(await readFile(new URL('README.md', root), 'utf8'), /\/speak/);
  assert.match(await readFile(new URL('CHANGELOG.md', root), 'utf8'), /0\.1\.0/);
});

test('npm pack includes a decodable PNG preview rather than just an image metadata path', async () => {
  const png = await readFile(new URL(manifest.pi.image, root));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.ok(png.readUInt32BE(16) >= 128);
  assert.ok(png.readUInt32BE(20) >= 64);
  assert.equal(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: new URL('.', root), encoding: 'utf8', shell: process.platform === 'win32' /* T62: npm is npm.cmd there, which needs a shell */ }));
  const files = new Set(pack.files.map((file: { path: string }) => file.path));
  for (const path of ['assets/preview.png', 'assets/logo.svg', 'README.md', 'CHANGELOG.md', 'LICENSE', 'extensions/gentle-speak.ts', 'scripts/requirements-qwen.txt']) assert.ok(files.has(path), `missing ${path}`);
  // T63: the lock regeneration tool exists in the repository but is never published; nor are the internal directories the CI pack check rejects.
  assert.ok(existsSync(new URL('scripts/lock-qwen.mjs', root)), 'the lock script exists');
  assert.equal(files.has('scripts/lock-qwen.mjs'), false, 'the lock script is not shipped');
  assert.deepEqual([...files].filter(path => /^(odd|tests|docs|\.github)\//.test(path)), []);
  assert.ok(pack.size > png.length);
});
