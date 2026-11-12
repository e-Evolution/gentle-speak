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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { headerProblems, sourceFiles } from "./helpers/source-files.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("source files are discovered without git", () => {
  const files = sourceFiles(root);
  assert.ok(files.length >= 70, `found ${files.length}`);
  assert.ok(files.includes("extensions/gentle-speak.ts"));
  assert.ok(files.includes("scripts/speak-qwen-worker.py"));
  assert.ok(files.includes("tests/helpers/source-files.ts"));
});

test("every source file carries the MIT header and keeps its shebang first", () => {
  assert.deepEqual(headerProblems(root), []);
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
