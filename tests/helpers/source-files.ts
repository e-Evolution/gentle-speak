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
// T54 (S17): walks the source directories itself (no git needed) and checks the MIT header.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE_DIRS = ['extensions', 'lib', 'scripts', 'tests'];
export const SOURCE_EXTENSIONS = ['.ts', '.cjs', '.mjs', '.py', '.sh'];
export const COPYRIGHT = 'Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com';
export const SPDX = 'SPDX-License-Identifier: MIT';

/** Every source file (repository-relative, sorted) under the source directories; node_modules and dot directories are skipped. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path); }
      else if (entry.isFile() && SOURCE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) out.push(path);
    }
  };
  for (const dir of SOURCE_DIRS) walk(dir);
  return out.sort();
}

/** The files whose first lines are not the header (after an optional shebang), or whose shebang is not on line 1. */
export function headerProblems(root: string, files: readonly string[] = sourceFiles(root)): string[] {
  const bad: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    const hash = file.endsWith('.py') || file.endsWith('.sh');
    const hasShebang = lines[0].startsWith('#!');
    const head = lines.slice(hasShebang ? 1 : 0, (hasShebang ? 1 : 0) + 16);
    const ok = hash
      ? head[0] === `# ${COPYRIGHT}` && head[1] === `# ${SPDX}`
      : head[0] === '/**' && head[1] === ` * ${COPYRIGHT}` && head[2] === ` * ${SPDX}` && head.join('\n').includes('\n */');
    if (!ok) bad.push(file);
    if (!hasShebang && /^#!/m.test(lines.slice(1).join('\n'))) bad.push(`${file} (shebang not first)`);
  }
  return bad;
}
