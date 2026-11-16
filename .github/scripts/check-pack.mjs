/**
 * Copyright (C) 2026, e-Evolution Consultants S.A. , http://www.e-evolution.com
 * SPDX-License-Identifier: MIT
 */
// Fails when the npm package would include files that must not be published.
import { execFileSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [pkg] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const files = pkg.files.map((f) => f.path);
const unexpected = files.filter((f) => /^(odd|tests|docs|\.github)\//.test(f));
console.log(`${pkg.name}@${pkg.version}: ${files.length} files, ${pkg.size} bytes`);
if (unexpected.length > 0) {
  console.error("Unexpected files in the package:", unexpected.join(", "));
  process.exit(1);
}
