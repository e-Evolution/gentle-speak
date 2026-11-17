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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectDot, disconnectDot, isSpeakEntry, resolveDotSource } from '../lib/speak-dot.ts';

// T53 (S5, S12, L106): the package is now @e-evolution/gentle-speak; the legacy unscoped name keeps working.
const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function world(terminalPackages: unknown[], dotPackages?: unknown[], rootName = '@e-evolution/gentle-speak') {
  const base = mkdtempSync(join(tmpdir(), 'speak-t53-')); roots.push(base);
  const home = join(base, 'home'), shell = join(base, 'shell'), dot = join(home, '.gentle-dot', 'agent'), root = join(base, 'root');
  for (const dir of [shell, dot, root]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shell, 'settings.json'), JSON.stringify({ packages: terminalPackages }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: rootName }));
  if (dotPackages) writeFileSync(join(dot, 'settings.json'), JSON.stringify({ theme: 'x', packages: dotPackages }, null, 2));
  return { base, dot, root, io: { env: { PI_CODING_AGENT_DIR: shell } as Record<string, string | undefined>, home, packageRoot: root } };
}
const dotPackages = (dot: string) => JSON.parse(readFileSync(join(dot, 'settings.json'), 'utf8')).packages;

test('T53: the scoped npm spec is accepted, with or without a version, as string or object', () => {
  for (const spec of ['npm:@e-evolution/gentle-speak', 'npm:@e-evolution/gentle-speak@0.1.0', 'npm:@e-evolution/gentle-speak@^1.2.3', 'npm:@e-evolution/gentle-speak@latest']) {
    assert.equal(isSpeakEntry(spec), true, spec); assert.equal(isSpeakEntry({ source: spec }), true, spec);
    assert.equal(resolveDotSource(world([spec]).io), spec, spec);
  }
  const entry = { source: 'npm:@e-evolution/gentle-speak@1', extensions: ['a'] };
  assert.deepEqual(resolveDotSource(world([entry]).io), entry);
});
test('T53: the legacy unscoped npm spec still works', () => {
  for (const spec of ['npm:gentle-speak', 'npm:gentle-speak@0.3.0']) { assert.equal(isSpeakEntry(spec), true, spec); assert.equal(resolveDotSource(world([spec]).io), spec, spec); }
});
test('T53: a foreign scope or malformed scoped spec is never copied to Dot', () => {
  for (const spec of ['npm:@other/gentle-speak', 'npm:@other/gentle-speak@1', 'npm:@e-evolution/other', 'npm:@e-evolution/gentle-speak-fork', 'npm:@e-evolution/gentle-speak@', 'npm:@e-evolution/gentle-speak@a b', 'npm:@E-Evolution/gentle-speak', 'npm:@e-evolution/gentle-speak/extra']) {
    const w = world([spec]); assert.notEqual(resolveDotSource(w.io), spec, spec);
  }
  assert.equal(resolveDotSource(world(['npm:@other/gentle-speak']).io), undefined); // detected as a speak entry but refused, like T41's npm:@evil
  assert.equal(isSpeakEntry('npm:@e-evolution/gentle-speak-extra'), false);
});
test('T53: a local dir named @e-evolution/gentle-speak or gentle-speak is accepted; another name is refused', () => {
  const run = (name: string) => {
    const w = world([], undefined, name);
    const checkout = join(w.base, 'checkout', 'gentle-speak'); mkdirSync(checkout, { recursive: true }); writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name }));
    writeFileSync(join(w.base, 'shell', 'settings.json'), JSON.stringify({ packages: [checkout] }));
    return { got: resolveDotSource(w.io), checkout };
  };
  for (const name of ['@e-evolution/gentle-speak', 'gentle-speak']) { const r = run(name); assert.equal(r.got, r.checkout, name); }
  for (const name of ['@other/gentle-speak', 'other', '@e-evolution/other']) assert.equal(run(name).got, undefined, name);
});
test('T53: the installed package itself (scoped or legacy name) is the fallback source', () => {
  const w = world([]); assert.equal(resolveDotSource(w.io), w.root);
  const legacy = world([], undefined, 'gentle-speak'); assert.equal(resolveDotSource(legacy.io), legacy.root);
});
test('T53: git forms are unchanged', () => {
  const spec = 'git:github.com/e-Evolution/gentle-speak@v1';
  assert.equal(resolveDotSource(world([spec]).io), spec);
  assert.equal(isSpeakEntry('git:github.com/x/other'), false);
});
test('T53: connect is a no-op when either name is already present; disconnect removes either', () => {
  for (const present of ['npm:@e-evolution/gentle-speak@1', 'npm:gentle-speak']) {
    const w = world(['npm:@e-evolution/gentle-speak'], ['other', present]);
    const source = resolveDotSource(w.io)!, files = readdirSync(w.dot).sort();
    assert.deepEqual(connectDot(source, w.io), { ok: true, changed: false });
    assert.deepEqual(readdirSync(w.dot).sort(), files);
    assert.deepEqual(dotPackages(w.dot), ['other', present]);
    const r = disconnectDot(w.io); assert.equal(r.ok && r.changed, true);
    assert.deepEqual(dotPackages(w.dot), ['other']);
    assert.deepEqual(disconnectDot(w.io), { ok: true, changed: false });
  }
  const w = world(['npm:@e-evolution/gentle-speak'], ['other', 'npm:gentle-speak@0.3', { source: 'npm:@e-evolution/gentle-speak' }, 'npm:@other/keep']);
  disconnectDot(w.io);
  assert.deepEqual(dotPackages(w.dot), ['other', 'npm:@other/keep']);
});
test('T53: connecting writes the scoped spec once', () => {
  const w = world(['npm:@e-evolution/gentle-speak@2'], ['other']);
  assert.equal(connectDot(resolveDotSource(w.io)!, w.io).ok, true);
  assert.deepEqual(dotPackages(w.dot), ['other', 'npm:@e-evolution/gentle-speak@2']);
});
test('T53: README installs the scoped package and restarts with gentle-shell -r instead of /reload in Quick start', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const quick = readme.slice(readme.indexOf('## Quick start'), readme.indexOf('Try it once without installing'));
  assert.match(readme, /npm:@e-evolution\/gentle-speak/);
  assert.match(quick, /gentle-shell install npm:@e-evolution\/gentle-speak/);
  assert.match(quick, /gentle-shell install git:github\.com\/e-Evolution\/gentle-speak/);
  assert.doesNotMatch(quick, /once the repository is public/i); // the repository is public: the git source works today
  assert.match(quick, /Once published/);
  assert.match(quick, /gentle-shell install \.\//);
  assert.match(quick, /gentle-shell -r/);
  assert.doesNotMatch(quick, /Run `\/reload`/);
  assert.doesNotMatch(readme, /@e-Evolution\/gentle-speak/);
});
test('T53: package.json, notices and changelog use the scoped name', () => {
  const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.equal(JSON.parse(read('package.json')).name, '@e-evolution/gentle-speak');
  assert.match(read('CHANGELOG.md'), /@e-evolution\/gentle-speak/);
});
