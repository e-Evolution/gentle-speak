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
// T38 test fixture: a temp shared home (real unix sockets, never the real home), a fake Python (`sh` wrapper -> node) and a fake worker
// that speaks gentle.speak.qwen/v1 and logs every process start and every synth, so tests can count Python processes and see the order.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { connectQwenService, qwenServicePaths, stopQwenService, type QwenServiceOptions } from '../../lib/speak-qwen-service.ts';

export const SERVICE_SCRIPT = resolve(import.meta.dirname, '../../scripts/speak-qwen-service.mjs');
const FAKE_WORKER = `
import fs from 'node:fs';
import readline from 'node:readline';
const dir = process.env.FW_DIR;
fs.appendFileSync(dir + '/workers.log', 'start ' + process.pid + '\\n');
fs.appendFileSync(dir + '/cwd.log', process.cwd() + '\\n'); // T61: where the service started its Python
const send = (m) => process.stdout.write(JSON.stringify({ schema: 'gentle.speak.qwen/v1', ...m }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on('line', line => { chain = chain.then(() => handle(JSON.parse(line))); });
rl.on('close', () => chain.then(() => process.exit(0)));
async function handle(m) {
  if (m.type !== 'synth') return;
  fs.appendFileSync(dir + '/order.log', m.text + '\\n');
  await new Promise(r => setTimeout(r, m.text.startsWith('slow') ? 400 : 15));
  if (m.text.includes('boom')) { send({ type: 'error', id: m.id, message: 'synthesis failed' }); return; }
  const wav = m.outDir + '/chunk-' + m.id + '-0.wav';
  fs.writeFileSync(wav, 'RIFF');
  send({ type: 'chunk', id: m.id, seq: 0, wav, seconds: 1 });
  send({ type: 'done', id: m.id });
}
setTimeout(() => send({ type: 'ready' }), Number(process.env.FW_READY_DELAY_MS ?? 0)); // a slow model load, when a test asks for one
`;

export function qwenFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gsq-'));
  const home = join(root, 'h');
  mkdirSync(join(home, 'voices', 'custom', 'ref'), { recursive: true }); // T45: the service accepts only voices/custom/<id>/reference.wav
  const ref = join(home, 'voices', 'custom', 'ref', 'reference.wav');
  writeFileSync(ref, 'RIFF');
  const worker = join(root, 'fake-worker.mjs');
  writeFileSync(worker, FAKE_WORKER);
  const python = join(root, 'fake-python');
  writeFileSync(python, `#!/bin/sh\nshift 2\nexec "${process.execPath}" "$@"\n`);
  chmodSync(python, 0o755);
  const read = (name: string) => { try { return readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const options = (extra: Partial<QwenServiceOptions> = {}): QwenServiceOptions => ({ home, python, script: worker, serviceScript: SERVICE_SCRIPT, idleMs: null, exitIdleMs: 60_000, env: { ...process.env, FW_DIR: root }, timeoutMs: 8000, ...extra });
  const paths = qwenServicePaths(home);
  const pidOf = () => { try { return Number(readFileSync(paths.pid, 'utf8').trim()); } catch { return undefined; } };
  const isAlive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  const workerPids = () => read('workers.log').map(line => Number(line.split(' ')[1]));
  const outDir = () => { const dir = mkdtempSync(join(tmpdir(), 'gsq-out-')); toRemove.push(dir); return dir; };
  const toRemove: string[] = [];
  /** Stops only what this fixture started, then removes the scratch. */
  async function close() {
    try { await stopQwenService(home, 1500); } catch { /* not running */ }
    for (const pid of [pidOf(), ...workerPids()]) if (isAlive(pid)) { try { process.kill(pid!, 'SIGKILL'); } catch { /* gone */ } }
    for (const dir of [...toRemove, root]) rmSync(dir, { recursive: true, force: true });
  }
  return { root, home, ref, paths, options, read, pidOf, isAlive, workerPids, outDir, close };
}

/** A line-oriented protocol client over the real socket. */
export function rawClient(socket: net.Socket, rest = '') {
  const messages: any[] = [];
  let buffer = rest;
  const drain = () => { let at: number; while ((at = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); } };
  drain();
  socket.on('data', (chunk: string) => { buffer += chunk; drain(); });
  const send = (message: object) => socket.write(JSON.stringify({ schema: 'gentle.speak.qwen-service/v1', ...message }) + '\n');
  const waitFor = async (predicate: (all: any[]) => boolean, what = 'condition', ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (predicate(messages)) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(messages)}`);
  };
  return { messages, send, waitFor, socket, ofId: (id: number) => messages.filter(m => m.id === id) };
}

export async function until(predicate: () => boolean, what = 'condition', ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await new Promise(r => setTimeout(r, 15)); }
  throw new Error(`timed out waiting for ${what}`);
}
export { connectQwenService, existsSync };
