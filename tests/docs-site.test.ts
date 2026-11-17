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

/** The English manual pages at the docs root, and their Spanish counterparts under docs/es/ (ASCII file names). */
const englishPages = ['index.md', 'installation.md', 'usage.md', 'voices.md', 'configuration.md', 'gentle-dot.md', 'architecture.md', 'platforms.md', 'requirements.md', 'troubleshooting.md', 'privacy.md', 'licenses.md', 'contributing.md'];
const spanishPages: Record<string, string> = {
  'index.md': 'es/index.md', 'installation.md': 'es/instalacion.md', 'usage.md': 'es/uso.md', 'voices.md': 'es/voces.md',
  'configuration.md': 'es/configuracion.md', 'gentle-dot.md': 'es/gentle-dot.md', 'architecture.md': 'es/arquitectura.md',
  'platforms.md': 'es/plataformas.md', 'requirements.md': 'es/requisitos.md', 'troubleshooting.md': 'es/problemas.md', 'privacy.md': 'es/privacidad.md',
  'licenses.md': 'es/licencias.md', 'contributing.md': 'es/contribuir.md',
};

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

test('docs: every page has front matter with a title, and nav_order values are unique integers among siblings', () => {
  assert.ok(pages.length >= 24, `expected the English and Spanish manual pages, found ${pages.length}`);
  const orders = new Map<string, string>();
  for (const page of pages) {
    const meta = frontMatter(read(page));
    assert.ok(meta.title, `${page}: missing title`);
    assert.match(meta.nav_order ?? '', /^\d+$/, `${page}: nav_order must be an integer`);
    const key = `${meta.parent ?? ''}#${meta.nav_order}`;
    assert.ok(!orders.has(key), `${page}: nav_order ${meta.nav_order} also used by ${orders.get(key)} under the same parent`);
    orders.set(key, page);
  }
  for (const page of englishPages) assert.ok(pages.includes(page), `missing page ${page}`);
  for (const page of Object.values(spanishPages)) assert.ok(pages.includes(page), `missing page ${page}`);
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

test('docs: every English page has a Spanish counterpart under es/, and the other way round', () => {
  assert.deepEqual(pages.filter(page => !page.includes('/')).sort(), [...englishPages].sort(), 'the English pages are exactly the known list');
  assert.deepEqual(pages.filter(page => page.startsWith('es/')).sort(), Object.values(spanishPages).sort(), 'the Spanish pages are exactly the counterparts');
  assert.deepEqual(pages.filter(page => page.includes('/') && !page.startsWith('es/')), [], 'no pages outside the root and es/');
  for (const page of Object.values(spanishPages)) assert.match(page, /^es\/[a-z-]+\.md$/, `${page}: ASCII file name`);
});

test('docs: the Spanish section is one parent with lang es, and every Spanish page sits under it with lang es', () => {
  const home = frontMatter(read('es/index.md'));
  assert.equal(home.title, 'Español');
  assert.equal(home.has_children, 'true');
  assert.equal(home.has_toc, 'false', 'the theme\'s English "Table of contents" list is replaced by the page\'s own table');
  assert.equal(home.lang, 'es');
  assert.equal(home.parent, undefined);
  const lastEnglish = Math.max(...englishPages.map(page => Number(frontMatter(read(page)).nav_order)));
  assert.ok(Number(home.nav_order) > lastEnglish, 'the Spanish section comes after the English pages');
  for (const page of Object.values(spanishPages).filter(page => page !== 'es/index.md')) {
    const meta = frontMatter(read(page));
    assert.equal(meta.parent, home.title, `${page}: parent`);
    assert.equal(meta.lang, 'es', `${page}: lang`);
    assert.equal(meta.permalink, undefined, `${page}: keeps the .html URL style of the English pages`);
  }
  for (const page of englishPages) assert.equal(frontMatter(read(page)).lang, undefined, `${page}: English pages use the site lang`);
});

test('docs: every page names its translation, and the language switch links resolve both ways', () => {
  for (const [english, spanish] of Object.entries(spanishPages)) {
    assert.equal(frontMatter(read(english)).translation, spanish, `${english}: translation`);
    assert.equal(frontMatter(read(spanish)).translation, english, `${spanish}: translation`);
    assert.ok(existsSync(join(docs, spanish)) && existsSync(join(docs, english)));
  }
  const header = read('_includes/header_custom.html');
  assert.match(header, /site\.pages \| where: "path", page\.translation \| first/, 'the switch looks the translation up by source path');
  assert.match(header, /translated\.url \| relative_url/, 'the switch links to the translated page under the baseurl');
  assert.match(header, />\{\{ switch_label \}\}</);
  assert.match(header, /"English"/);
  assert.match(header, /"Español"/);
  assert.match(header, /page\.lang == "es"/);
});

test('docs: <html lang> follows the page lang, so Spanish pages are served as lang es', () => {
  const layout = read('_layouts/default.html');
  assert.match(layout, /^---\nlayout: table_wrappers\n---\n/, 'the override keeps the theme\'s layout chain');
  assert.match(layout, /<html lang="\{\{ page\.lang \| default: site\.lang \| default: 'en-US' \}\}">/);
  for (const include of ['head.html', 'components/sidebar.html', 'components/header.html', 'components/breadcrumbs.html', 'components/footer.html']) assert.ok(layout.includes(`{% include ${include} %}`), `the override still includes ${include}`);
  const config = read('_config.yml');
  assert.match(config, /^lang: en$/m);
  assert.match(config, /^  nota:\n    title: Nota$/m, 'Spanish note callout');
  assert.match(config, /^  advertencia:\n    title: Advertencia$/m, 'Spanish warning callout');
  assert.match(config, /^footer_content_es: >-$/m);
  assert.match(read('_includes/footer_custom.html'), /site\.footer_content_es/);
  assert.match(read('_includes/search_placeholder_custom.html'), /Buscar en/);
});

test('docs: each Spanish page translates its English page completely (same headings, tables, lists and code)', () => {
  const shape = (text: string) => {
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const fences = [...body.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)];
    const prose = body.replace(/^```[\s\S]*?^```/gm, '');
    return {
      headings: [...prose.matchAll(/^(#{1,6}) /gm)].map(match => match[1].length),
      code: fences.filter(match => match[1] !== 'mermaid').map(match => match[0]),
      mermaid: fences.filter(match => match[1] === 'mermaid').map(match => match[2].replace(/"[^"]*"|\|[^|]*\||\(\("[^"]*"\)\)/g, '·')),
      tableRows: prose.match(/^\|/gm)?.length ?? 0,
      listItems: prose.match(/^\s*(?:- |\d+\. )/gm)?.length ?? 0,
      callouts: prose.match(/^\{: \.(?:note|warning|nota|advertencia) \}$/gm)?.length ?? 0,
      links: [...prose.matchAll(/\]\((https?:[^)\s]+)\)/g)].map(match => match[1]),
    };
  };
  for (const [english, spanish] of Object.entries(spanishPages)) assert.deepEqual(shape(read(spanish)), shape(read(english)), `${spanish} does not match the shape of ${english}`);
  for (const page of Object.values(spanishPages)) assert.doesNotMatch(read(page), /^\{: \.(?:note|warning) \}$/m, `${page}: use the Spanish callouts nota and advertencia`);
});

test('docs: README links the English and the Spanish manual', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
  assert.match(readme, /\(https:\/\/e-evolution\.github\.io\/gentle-speak\/\)/);
  assert.match(readme, /\[manual en español\]\(https:\/\/e-evolution\.github\.io\/gentle-speak\/es\/\)/);
});
