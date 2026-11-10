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
