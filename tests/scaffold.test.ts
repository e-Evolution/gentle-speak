import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));

test('npm and Pi discover the inert extension entrypoint', async () => {
  assert.equal(manifest.name, 'gentle-speak');
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.deepEqual(manifest.pi.extensions, ['./extensions/gentle-speak.ts']);
  assert.equal(typeof manifest.pi.image, 'string');
  assert.ok(manifest.pi.image.length > 0);
  assert.deepEqual(manifest.peerDependencies, {
    '@earendil-works/pi-coding-agent': '*',
    '@earendil-works/pi-tui': '*',
  });
  assert.ok(!manifest.dependencies?.['@earendil-works/pi-coding-agent']);
  assert.ok(!manifest.dependencies?.['@earendil-works/pi-tui']);
  assert.deepEqual(manifest.files, ['extensions/', 'lib/', 'scripts/', 'README.md', 'LICENSE']);
  assert.equal(manifest.scripts.test, 'node --experimental-strip-types --test tests/*.test.ts');
  assert.match(await readFile(new URL('extensions/gentle-speak.ts', root), 'utf8'), /export default function/);
});

test('package includes its stated license and instructions', async () => {
  assert.match(await readFile(new URL('LICENSE', root), 'utf8'), /MIT License/);
  assert.match(await readFile(new URL('README.md', root), 'utf8'), /not yet implemented/i);
});
