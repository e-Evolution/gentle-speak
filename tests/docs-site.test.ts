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
// The GitHub Pages user manual under docs/: front matter, theme config, assets, internal links and no private or internal references.
import './helpers/guard-real-home.ts';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
const read = (rel: string) => readFileSync(join(docs, rel), 'utf8');

/** Every file under docs/ (posix, relative), sorted. */
function walk(rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(docs, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}
const files = walk();
const pages = files.filter(file => file.endsWith('.md'));
const textFiles = files.filter(file => /\.(md|ya?ml|html|scss|js)$/.test(file));

/** A flat YAML front matter block (`key: value` lines only), parsed strictly: any other line is an error. */
function frontMatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('no front matter block at the top');
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const pair = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`not a flat key: value line: ${JSON.stringify(line)}`);
    if (Object.hasOwn(out, pair[1])) throw new Error(`duplicate key ${pair[1]}`);
    let value = pair[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    else if (/^["']/.test(value)) throw new Error(`unterminated quote for ${pair[1]}`);
    out[pair[1]] = value;
  }
  return out;
}

/** Heading ids as kramdown (GFM input) generates them: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) => heading.replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().replace(/ /g, '-');
function anchors(text: string): Set<string> {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^```[\s\S]*?^```/gm, '');
  return new Set([...body.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(match => slug(match[1])));
}

test('docs: every page has front matter with a title, and nav_order values are unique integers', () => {
  assert.ok(pages.length >= 12, `expected the manual pages, found ${pages.length}`);
  const orders = new Map<string, string>();
  for (const page of pages) {
    const meta = frontMatter(read(page));
    assert.ok(meta.title, `${page}: missing title`);
    assert.match(meta.nav_order ?? '', /^\d+$/, `${page}: nav_order must be an integer`);
    assert.ok(!orders.has(meta.nav_order), `${page}: nav_order ${meta.nav_order} also used by ${orders.get(meta.nav_order)}`);
    orders.set(meta.nav_order, page);
  }
  for (const page of ['index.md', 'installation.md', 'usage.md', 'voices.md', 'configuration.md', 'gentle-dot.md', 'architecture.md', 'platforms.md', 'troubleshooting.md', 'privacy.md', 'licenses.md', 'contributing.md']) assert.ok(pages.includes(page), `missing page ${page}`);
});

test('docs: _config.yml uses the just-the-docs remote theme under /gentle-speak with the gentle color scheme', () => {
  const config = read('_config.yml');
  assert.match(config, /^remote_theme: just-the-docs\/just-the-docs@v0\.10\.1$/m);
  assert.match(config, /^baseurl: \/gentle-speak$/m);
  assert.match(config, /^url: https:\/\/e-evolution\.github\.io$/m);
  assert.match(config, /^color_scheme: gentle$/m);
  assert.match(config, /^search_enabled: true$/m);
  assert.match(config, /^\s+- jekyll-remote-theme$/m);
  assert.match(config, /^\s+- jekyll-seo-tag$/m);
  assert.match(config, /^mermaid:\n\s+version: "\d+\.\d+\.\d+"$/m);
  assert.match(config, /^logo: \/assets\/images\/logo\.svg$/m);
  assert.doesNotMatch(config, /\t/, 'YAML must not contain tabs');
});

test('docs: the color scheme, logo and favicon exist', () => {
  const scheme = read('_sass/color_schemes/gentle.scss');
  assert.match(scheme, /^\$color-scheme: dark;$/m);
  for (const variable of ['body-background-color', 'body-text-color', 'body-heading-color', 'link-color', 'sidebar-color', 'border-color', 'code-background-color', 'btn-primary-color']) assert.match(scheme, new RegExp(`^\\$${variable}:`, 'm'), `missing $${variable}`);
  for (const asset of ['assets/images/logo.svg', 'assets/images/preview.png', 'favicon.svg', 'favicon-32.png']) assert.ok(existsSync(join(docs, asset)) && statSync(join(docs, asset)).size > 0, `missing ${asset}`);
  assert.equal(read('assets/images/logo.svg'), readFileSync(new URL('../assets/logo.svg', import.meta.url), 'utf8'), 'the site logo is the package logo');
  const head = read('_includes/head_custom.html');
  assert.match(head, /favicon\.svg/);
  assert.match(head, /favicon-32\.png/);
});

test('docs: every relative link between pages points to an existing page and heading', () => {
  const problems: string[] = [];
  for (const page of pages) {
    const text = read(page).replace(/^```[\s\S]*?^```/gm, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split('#');
      const file = path ? posix.normalize(posix.join(posix.dirname(page), path)) : page;
      if (path && !path.endsWith('.md')) { problems.push(`${page}: ${target} is not a .md page link`); continue; }
      if (!pages.includes(file)) { problems.push(`${page}: ${target} points to a missing page`); continue; }
      if (anchor && !anchors(read(file)).has(anchor)) problems.push(`${page}: ${target} points to a missing heading`);
    }
  }
  assert.deepEqual(problems, []);
});

test('docs: no personal paths and no internal task references', () => {
  for (const file of textFiles) {
    const text = read(file);
    assert.doesNotMatch(text, /\/Users\//, `${file} contains a personal path`);
    assert.doesNotMatch(text, /\b(T\d{1,2}|L\d{2,3})\b/, `${file} contains an internal reference`);
    assert.doesNotMatch(text, /\bODD\b|odd\/tasks/, `${file} mentions the internal workflow`);
  }
});

test('docs: no page or README restarts with `pi -r` (plain pi is vanilla Pi; Gentle Shell users run gentle-shell -r)', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  for (const [file, text] of [['README.md', readme], ...textFiles.map(file => [file, read(file)])]) {
    assert.doesNotMatch(text, /(^|[^\w-])pi -r\b/m, `${file} says pi -r`);
  }
  assert.match(readme, /gentle-shell -r/);
  assert.match(read('installation.md'), /gentle-shell -r/);
});
