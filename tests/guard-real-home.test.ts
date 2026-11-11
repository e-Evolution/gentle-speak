import { allowRealRead, realHomeForGuard, takeViolations } from './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, promises } from 'node:fs';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// T35 (S5, S12): the guard itself. Every access below is blocked BEFORE it executes, so nothing real is touched.
const ROOTS = ['.gentle-dot', '.gentle-speak', '.gentle-shell', '.pi'];

test('guard: reads and writes of the real .gentle-dot, .gentle-speak, .gentle-shell and .pi throw, sync, callback and promise forms', async () => {
  for (const root of ROOTS) {
    const path = join(realHomeForGuard, root, 'guard-probe', 'settings.json');
    assert.throws(() => existsSync(path), /guard-real-home/);
    assert.throws(() => readFileSync(path), /guard-real-home/);
    assert.throws(() => writeFileSync(path, 'x'), /guard-real-home/);
    assert.throws(() => mkdirSync(join(realHomeForGuard, root, 'guard-probe'), { recursive: true }), /guard-real-home/);
    assert.throws(() => nodeFs.renameSync(path, path + '.x'), /guard-real-home/);
    assert.throws(() => nodeFs.copyFileSync(path, path + '.bak'), /guard-real-home/);
    assert.throws(() => nodeFs.unlinkSync(path), /guard-real-home/);
    assert.throws(() => nodeFs.readFile(path, () => {}), /guard-real-home/);
    await assert.rejects(async () => promises.readFile(path), /guard-real-home/);
    await assert.rejects(async () => promises.writeFile(path, 'x'), /guard-real-home/);
  }
  assert.ok(takeViolations().length >= ROOTS.length * 10, 'every blocked access is recorded');
});

test('guard: unrelated real paths and the scratch dir stay usable; allowRealRead exempts reads only', () => {
  assert.doesNotThrow(() => existsSync(join(realHomeForGuard, 'guard-test-unrelated-dir')));
  const exempt = join(realHomeForGuard, '.pi', 'guard-test-allowlisted');
  allowRealRead(exempt);
  assert.doesNotThrow(() => existsSync(exempt));
  assert.throws(() => writeFileSync(exempt, 'x'), /guard-real-home/);
  assert.equal(takeViolations().length, 1);
});
