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
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const COPYRIGHT = "Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com";
const SPDX = "SPDX-License-Identifier: MIT";

function tracked(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "extensions/*.ts", "lib/*.ts", "scripts/*.cjs", "scripts/*.mjs", "scripts/*.py", "scripts/*.sh", "tests/*.ts"],
    { cwd: root, encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean);
}

test("source files are discovered", () => {
  const files = tracked();
  assert.ok(files.length >= 70, `found ${files.length}`);
  assert.ok(files.includes("extensions/gentle-speak.ts"));
  assert.ok(files.includes("scripts/speak-qwen-worker.py"));
});

test("every tracked source file carries the MIT header and keeps its shebang first", () => {
  const bad: string[] = [];
  for (const file of tracked()) {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    const hash = file.endsWith(".py") || file.endsWith(".sh");
    const hasShebang = lines[0].startsWith("#!");
    const head = lines.slice(hasShebang ? 1 : 0, (hasShebang ? 1 : 0) + 16);
    const text = head.join("\n");
    const ok = hash
      ? head[0] === `# ${COPYRIGHT}` && head[1] === `# ${SPDX}`
      : head[0] === "/**" && head[1] === ` * ${COPYRIGHT}` && head[2] === ` * ${SPDX}` && text.includes("\n */");
    if (!ok) bad.push(file);
    if (/^#!/m.test(lines.slice(1).join("\n")) && !hasShebang) bad.push(`${file} (shebang not first)`);
  }
  assert.deepEqual(bad, []);
});

test("LICENSE names the holder and is still MIT", () => {
  const text = readFileSync(join(root, "LICENSE"), "utf8");
  assert.match(text, /^MIT License$/m);
  assert.ok(text.includes("Copyright (c) 2026 e-Evolution Consultants S.A."));
  assert.match(text, /Permission is hereby granted, free of charge/);
});

test("package.json has author and repository", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.author, "Victor Perez <victor.perez@e-evolution.com> (http://www.e-evolution.com)");
  assert.deepEqual(pkg.repository, { type: "git", url: "git+https://github.com/e-Evolution/gentle-speak.git" });
  assert.equal(pkg.license, "MIT");
});
