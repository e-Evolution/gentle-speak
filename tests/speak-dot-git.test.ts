import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectDot, disconnectDot, isSpeakEntry, resolveDotSource } from '../lib/speak-dot.ts';

// T41 (S12, L86): a git source of the gentle-speak repo (Pi forms `git:host/owner/repo[@ref]` and `https://host/owner/repo`) is copied to Dot.
const roots: string[] = [];
test.afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function world(terminalPackages: unknown[], dotPackages?: unknown[]) {
  const base = mkdtempSync(join(tmpdir(), 'speak-t41-')); roots.push(base);
  const home = join(base, 'home'), shell = join(base, 'shell'), dot = join(home, '.gentle-dot', 'agent'), root = join(base, 'root');
  for (const dir of [shell, dot, root]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shell, 'settings.json'), JSON.stringify({ packages: terminalPackages }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'gentle-speak' }));
  if (dotPackages) writeFileSync(join(dot, 'settings.json'), JSON.stringify({ theme: 'x', packages: dotPackages }, null, 2));
  return { dot, io: { env: { PI_CODING_AGENT_DIR: shell } as Record<string, string | undefined>, home, packageRoot: root } };
}
const dotPackages = (dot: string) => JSON.parse(readFileSync(join(dot, 'settings.json'), 'utf8')).packages;
const ACCEPTED = [
  'git:github.com/e-Evolution/gentle-speak', 'git:github.com/e-Evolution/gentle-speak@v1.2.0', 'git:github.com/e-Evolution/gentle-speak.git', 'git:github.com/e-Evolution/gentle-speak.git@main',
  'git:git.example-corp.io/team-1/gentle-speak@feature/dot-1', 'https://github.com/e-Evolution/gentle-speak', 'https://github.com/e-Evolution/gentle-speak.git',
  'https://github.com/e-Evolution/gentle-speak@v1', 'https://github.com/e-Evolution/gentle-speak.git@abc123def',
];
const REFUSED = [
  'git:github.com/x/other', 'git:github.com/x/gentle-speak-fork', 'git:github.com/x/not-gentle-speak', 'https://github.com/x/gentle-speak2.git',
  'git:github.com/gentle-speak', 'git:/x/gentle-speak', 'https:///x/gentle-speak', 'https://github.com/x/gentle-speak/extra', 'https://github.com/a/b/gentle-speak',
  'https://user:pass@github.com/x/gentle-speak', 'https://user@github.com/x/gentle-speak', 'git:user:pass@github.com/x/gentle-speak',
  'https://github.com/x/gentle-speak?ref=v1', 'https://github.com/x/gentle-speak#frag', 'https://github.com/x/gentle-speak.git?x=1@v1',
  'git:github.com/x/gentle-speak@', 'git:github.com/x/gentle-speak@a b', 'git:github.com/x/gentle-speak@v1#x', `git:github.com/x/gentle-speak@${'a'.repeat(101)}`,
  'git@github.com:x/gentle-speak.git', 'ssh://git@github.com/x/gentle-speak.git', 'ssh://github.com/x/gentle-speak', 'file:///tmp/gentle-speak', 'file:/tmp/gentle-speak',
  'http://github.com/x/gentle-speak', 'git:-bad.host/x/gentle-speak', 'git:github.com/-x-/gentle-speak', 'git:github.com/x_y/gentle-speak',
  'npm:@evil/gentle-speak', 'npm:evil/gentle-speak', 'git:github.com/x/gentle-speak extra',
  './gentle-speak', '../missing/gentle-speak', 'rel/gentle-speak', '/nonexistent/t41/gentle-speak',
];

test('T41: each accepted git form is copied verbatim to Dot', () => {
  for (const spec of ACCEPTED) assert.equal(resolveDotSource(world([spec]).io), spec, spec);
});
test('T41: an object entry with a git source keeps its extra keys', () => {
  const entry = { source: 'git:github.com/e-Evolution/gentle-speak@v2', extensions: ['a'], skills: [] };
  assert.deepEqual(resolveDotSource(world([entry]).io), entry);
});
// An entry that does not look like gentle-speak at all is not "the terminal's gentle-speak entry": Dot gets the installed package root, never that entry.
const MUST_REFUSE = [
  'https://user:pass@github.com/x/gentle-speak', 'https://user@github.com/x/gentle-speak', 'git:user:pass@github.com/x/gentle-speak', 'git:github.com/gentle-speak', 'git:/x/gentle-speak',
  'https:///x/gentle-speak', 'https://github.com/a/b/gentle-speak', 'git@github.com:x/gentle-speak.git', 'ssh://git@github.com/x/gentle-speak.git', 'ssh://github.com/x/gentle-speak',
  'file:///tmp/gentle-speak', 'file:/tmp/gentle-speak', 'http://github.com/x/gentle-speak', 'git:github.com/x/gentle-speak@', 'git:github.com/x/gentle-speak@a b', `git:github.com/x/gentle-speak@${'a'.repeat(101)}`,
  'git:-bad.host/x/gentle-speak', 'git:github.com/-x-/gentle-speak', 'git:github.com/x_y/gentle-speak', 'npm:@evil/gentle-speak', 'npm:evil/gentle-speak', './gentle-speak', '../missing/gentle-speak', 'rel/gentle-speak', '/nonexistent/t41/gentle-speak',
];
test('T41: credentialed, malformed, ssh, file, http, npm and local sources of gentle-speak are refused (no write)', () => {
  for (const spec of MUST_REFUSE) { assert.equal(isSpeakEntry(spec), true, `${spec} is detected`); assert.equal(resolveDotSource(world([spec]).io), undefined, spec); }
  assert.equal(resolveDotSource(world([{ source: 'https://user:pw@github.com/x/gentle-speak' }]).io), undefined);
});
test('T41: other repository names, queries and fragments are never copied to Dot', () => {
  for (const spec of REFUSED) { const w = world([spec]); assert.notDeepEqual(resolveDotSource(w.io), spec, spec); }
  for (const spec of ['git:github.com/x/other', 'git:github.com/x/gentle-speak-fork', 'https://github.com/x/gentle-speak?ref=v1', 'https://github.com/x/gentle-speak#frag', 'https://github.com/x/gentle-speak2.git'])
    { const w = world([spec]); assert.equal(resolveDotSource(w.io), w.io.packageRoot, spec); }
});
test('T41: a refused git source writes nothing: connect is not attempted and Dot settings stay byte-identical', () => {
  const w = world(['https://user:pass@github.com/x/gentle-speak'], ['a']);
  const before = readFileSync(join(w.dot, 'settings.json'), 'utf8');
  assert.equal(resolveDotSource(w.io), undefined);
  assert.equal(readFileSync(join(w.dot, 'settings.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(w.dot), ['settings.json']);
});
test('T41: detection recognises the accepted git entries, as strings and objects', () => {
  for (const spec of ACCEPTED) { assert.equal(isSpeakEntry(spec), true, spec); assert.equal(isSpeakEntry({ source: spec }), true, spec); }
  assert.equal(isSpeakEntry('git:github.com/x/other@gentle-speak'), false);
});
test('T41: connecting a git source writes it once; connecting twice is a no-op with no second backup', () => {
  for (const spec of ['git:github.com/e-Evolution/gentle-speak.git@feature/x', 'https://github.com/e-Evolution/gentle-speak.git@v1']) {
    const w = world([spec], ['other']);
    const source = resolveDotSource(w.io)!;
    const first = connectDot(source, w.io);
    assert.equal(first.ok && first.changed, true);
    assert.deepEqual(dotPackages(w.dot), ['other', spec]);
    const files = readdirSync(w.dot).sort();
    assert.deepEqual(connectDot(source, w.io), { ok: true, changed: false });
    assert.deepEqual(readdirSync(w.dot).sort(), files);
    assert.deepEqual(dotPackages(w.dot), ['other', spec]);
  }
});
test('T41: disconnect removes the git entry (string or object) and keeps the rest', () => {
  const w = world([], ['other', 'git:github.com/e-Evolution/gentle-speak.git@feature/x', { source: 'https://github.com/e-Evolution/gentle-speak', extensions: [] }, 'git:github.com/x/keep']);
  const r = disconnectDot(w.io);
  assert.equal(r.ok && r.changed, true);
  assert.deepEqual(dotPackages(w.dot), ['other', 'git:github.com/x/keep']);
  assert.deepEqual(disconnectDot(w.io), { ok: true, changed: false });
});
