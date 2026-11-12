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
// Child process for the voice-lock stress tests. argv: dir log startAtMs iterations holdMs id
// Appends "S|E <id> <hrtime-ns>" lines to a shared O_APPEND log. Any uncaught error exits non-zero with a stack on stderr.
import fs from 'node:fs';
import { createVoiceLock } from '../../lib/speak-voice-lock.ts';

const [dir, log, startAt, iterations, holdMs, id] = process.argv.slice(2);
const lock = createVoiceLock({ dir, pollMs: 2, graceMs: 5000 });
const stamp = (kind: 'S' | 'E') => fs.appendFileSync(log, `${kind} ${id} ${process.hrtime.bigint()}\n`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const keepAlive = setInterval(() => {}, 1000); // the lock's poll timers are unref'd
while (Date.now() < Number(startAt)) await new Promise(r => setImmediate(r));
for (let i = 0; i < Number(iterations); i++) {
  await lock.acquire();
  stamp('S');
  await sleep(Number(holdMs));
  stamp('E');
  await lock.release();
}
clearInterval(keepAlive);
