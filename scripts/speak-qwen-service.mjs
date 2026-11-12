#!/usr/bin/env node
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
// T38 (S13): the shared local Qwen service. One process per user owns ONE Qwen Python worker (scripts/speak-qwen-worker.py) and serves
// every terminal session and Gentle Dot over a private unix socket: `<home>/qwen.sock`, mode 0600, in a 0700 directory.
//
// Plain JavaScript on purpose: it is started with `node` from an installed package, where Node does not strip TypeScript.
// Protocol: newline-delimited JSON, schema `gentle.speak.qwen-service/v1`.
//   server -> client  hello {version, build, pid} (first line) | chunk {id, seq, wav, seconds} | done {id} | error {id, message} | warning {id, message?} | queued {id}
//   client -> server  synth {id, priority: 'speak'|'prepare', text, ref, refText, outDir, speed} | cancel {id} | shutdown {now?}
// Request ids belong to one connection: the service maps them to its own ids for the Python worker, so clients never see each other's traffic.
// The service never executes anything it is sent: it validates every field and only ever runs the one worker it was started with.
//
// Lifetime (S13, L83): the model stays loaded while at least one client is connected, even with no requests (there is no per-request idle close).
// When the LAST client disconnects a grace countdown of `--idle-ms` (the user's qwenIdleMinutes; `never` = no countdown) starts from that moment, not
// from the last request. When it expires the Python worker is unloaded and the service exits, removing the socket and pid. A new connection during the
// grace cancels it. `--exit-idle-ms <n>` (tests) overrides only the grace length. A countdown never fires mid-request.
//
// Usage: node speak-qwen-service.mjs --home <dir> --python <exe> --script <worker.py> --version <v> [--idle-ms <n|never>] [--exit-idle-ms <n|never>]
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCHEMA = 'gentle.speak.qwen-service/v1';
const WORKER_SCHEMA = 'gentle.speak.qwen/v1';
// Same flags as lib/speak-voices.ts QWEN_PYTHON_FLAGS (a test keeps them equal).
const PYTHON_FLAGS = ['-E', '-P'];
const MAX_LINE = 65536, MAX_TEXT = 4000, MAX_JOBS_PER_CONNECTION = 64;
const READY_TIMEOUT_MS = 180_000, SYNTH_IDLE_TIMEOUT_MS = 120_000, HEARTBEAT_MS = 10_000;

const args = (() => {
  const out = {};
  for (let i = 2; i < process.argv.length; i += 2) out[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  return out;
})();
const home = args.home, python = args.python, script = args.script, version = args.version;
const number = (value, fallback) => (value === 'never' ? null : Number.isFinite(Number(value)) && value !== undefined && value !== '' ? Number(value) : fallback);
const idleMs = number(args['idle-ms'], 10 * 60_000);
/** The grace after the last client left (`null` never). */
const graceMs = args['exit-idle-ms'] === undefined ? idleMs : number(args['exit-idle-ms'], idleMs);
/** T50: the build id, derived exactly as lib/speak-qwen-service.ts qwenBuildId (sha256 over `<length>:<bytes>` of this script, then of the worker; first 12 hex). Sent in the hello. */
function buildId() {
  try {
    const hash = crypto.createHash('sha256');
    for (const file of [fileURLToPath(import.meta.url), script]) { const bytes = fs.readFileSync(file); hash.update(`${bytes.length}:`); hash.update(bytes); }
    return hash.digest('hex').slice(0, 12);
  } catch { return undefined; }
}
const log = (...parts) => process.stderr.write(`${new Date().toISOString()} [qwen-service ${process.pid}] ${parts.join(' ')}\n`);

if (!home || !path.isAbsolute(home) || !python || !script || !version) { log('usage: --home <abs dir> --python <exe> --script <worker.py> --version <v>'); process.exit(2); }
process.umask(0o077);
const build = buildId(); // computed once at start: a service describes the code it was started from
const socketPath = path.join(home, 'qwen.sock'), pidPath = path.join(home, 'qwen-service.pid'), customDir = path.join(home, 'voices', 'custom');

/** The home directory must be ours and private; anything else is refused (the socket would be reachable by others). */
function ensurePrivateDir() {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(home);
  if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('home is not a directory owned by the current user');
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(home, 0o700);
}

// ---- validation: every field of every request -------------------------------------------------------------------------------------------
const isPlainAbs = value => typeof value === 'string' && value.length <= 4095 && path.isAbsolute(value) && path.normalize(value) === value && !value.includes('\0');
/** Text is whitespace (tab, LF, CR, VT, FF) plus printable characters; any other control character (NUL, BEL, ESC, DEL...) is rejected. */
const UNSAFE_TEXT = /[\x00-\x08\x0e-\x1f\x7f]/;
/** What Python gets: CRLF and CR become LF, VT and FF become a space. Clients (Windows clipboards, pasted selections) legitimately send these. */
const normalizeText = text => text.replace(/\r\n?/g, '\n').replace(/[\x0b\x0c]/g, ' ');
/** S14 + T45: the only accepted reference. `voices/qwen3/` is no longer accepted: the migration copies the old built-in voices into `voices/custom/`, so nothing references it, and one narrower rule is easier to keep safe. A custom voice's reference is exactly `<home>/voices/custom/<id>/reference.wav` (id `^[a-z0-9][a-z0-9-]{0,31}$`), a regular file whose real path stays under the custom dir (no symlink out). */
function isCustomRef(ref) {
  const parts = path.relative(customDir, ref).split(path.sep);
  if (parts.length !== 2 || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(parts[0]) || parts[1] !== 'reference.wav') return false;
  try {
    if (!fs.lstatSync(ref).isFile()) return false;
    const real = fs.realpathSync(ref), root = fs.realpathSync(customDir);
    return real === path.join(root, parts[0], 'reference.wav');
  } catch { return false; }
}
const SYNTH_KEYS = ['schema', 'type', 'id', 'priority', 'text', 'ref', 'refText', 'outDir', 'speed'];
/** Returns a short reason when the synth request is invalid, else undefined. */
function invalidSynth(message) {
  const keys = Object.keys(message);
  if (keys.length !== SYNTH_KEYS.length || !SYNTH_KEYS.every(key => keys.includes(key))) return 'bad synth keys';
  if (message.priority !== 'speak' && message.priority !== 'prepare') return 'bad priority';
  const { text, refText, speed } = message;
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || UNSAFE_TEXT.test(text)) return 'bad text';
  if (typeof refText !== 'string' || !refText.trim() || refText.length > MAX_TEXT) return 'bad refText';
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) return 'bad speed';
  if (!isPlainAbs(message.ref) || !isCustomRef(message.ref)) return 'bad ref';
  if (!isPlainAbs(message.outDir)) return 'bad outDir';
  try {
    if (!fs.statSync(message.ref).isFile()) return 'ref is not a file';
    const dir = fs.lstatSync(message.outDir);
    if (!dir.isDirectory()) return 'outDir is not a directory';
    if (typeof process.getuid === 'function' && dir.uid !== process.getuid()) return 'outDir is not owned by the current user';
  } catch { return 'ref or outDir is not available'; }
  return undefined;
}

// ---- state -------------------------------------------------------------------------------------------------------------------------------
const connections = new Set();
/** @type {Array<Job>} */ const queue = [];
/** @type {Job | undefined} */ let running;
/** @type {{ child: import('node:child_process').ChildProcess, ready: boolean, readyTimer?: NodeJS.Timeout } | undefined} */ let worker;
/** When the last client left (or the service started with none): the grace is counted from here. `undefined` while a client is connected. */
let graceStart = Date.now();
let nextInternalId = 1, draining = false, server, exitTimer, jobTimer, heartbeat;
/** @typedef {{ conn: Connection, id: number, priority: 'speak'|'prepare', request: any, internalId: number, cancelled: boolean }} Job */
/** @typedef {{ socket: net.Socket, jobs: Map<number, Job>, closed: boolean, send: (message: object) => void }} Connection */

// ---- scheduling: one synthesis at a time, `speak` before `prepare`, FIFO inside a priority -----------------------------------------------
function pickNext() {
  const at = queue.findIndex(job => job.priority === 'speak');
  return queue.splice(at >= 0 ? at : 0, 1)[0];
}
function pump() {
  if (running || queue.length === 0) { settle(); return; }
  running = pickNext();
  try { if (!worker) startWorker(); } catch (error) { log('worker could not start:', String(error)); failRunning('Qwen worker could not start.'); return; }
  if (worker.ready) sendRunning();
  settle();
}
function sendRunning() {
  const job = running;
  if (!job || !worker) return;
  const { ref, refText, outDir, speed } = job.request, text = normalizeText(job.request.text);
  armJobTimer();
  try { worker.child.stdin.write(JSON.stringify({ schema: WORKER_SCHEMA, type: 'synth', id: job.internalId, text, ref, refText, outDir, speed }) + '\n'); }
  catch { killWorker(); failRunning('Qwen worker input failed.'); }
}
function armJobTimer() { clearTimeout(jobTimer); jobTimer = setTimeout(() => { log('synthesis timed out'); killWorker(); failRunning('Qwen worker timed out.'); }, SYNTH_IDLE_TIMEOUT_MS); }
function finishRunning() {
  clearTimeout(jobTimer);
  const job = running; running = undefined;
  if (job) job.conn.jobs.delete(job.id);
  pump();
}
function failRunning(message) {
  const job = running;
  if (job && !job.cancelled) job.conn.send({ type: 'error', id: job.id, message });
  finishRunning();
}

function startWorker() {
  const child = spawn(python, [...PYTHON_FLAGS, script], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const state = { child, ready: false };
  worker = state;
  state.readyTimer = setTimeout(() => { log('worker did not become ready'); if (worker === state) killWorker(); failRunning('Qwen worker did not become ready.'); }, READY_TIMEOUT_MS);
  child.stdin.on('error', () => { /* a dead worker is handled by its exit */ });
  child.stderr.on('data', data => process.stderr.write(data));
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE * 8) { buffer = ''; return; }
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); onWorkerLine(state, line); }
  });
  const gone = () => {
    clearTimeout(state.readyTimer);
    if (worker === state) { worker = undefined; failRunning('Qwen worker exited before speech finished.'); }
    settle();
  };
  child.on('error', gone);
  child.on('exit', gone);
}
function killWorker() {
  const old = worker; worker = undefined;
  if (!old) return;
  clearTimeout(old.readyTimer);
  try { old.child.stdin.end(); } catch { /* closed */ }
  try { old.child.kill(); } catch { /* gone */ }
}
function onWorkerLine(state, line) {
  if (worker !== state) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || message.schema !== WORKER_SCHEMA || typeof message.type !== 'string') return;
  if (message.type === 'ready') { state.ready = true; clearTimeout(state.readyTimer); if (running) sendRunning(); return; }
  if (message.type === 'error' && message.id === null) { log('worker error:', String(message.message)); killWorker(); failRunning('Qwen synthesis failed. Check that mlx-audio and the model are installed (see README, "Qwen voices").'); return; }
  const job = running;
  if (!job) return;
  if (message.type === 'warning') { if (!job.cancelled) job.conn.send({ type: 'warning', id: job.id, message: typeof message.message === 'string' ? message.message.slice(0, 200) : undefined }); armJobTimer(); return; }
  if (message.id !== job.internalId) return; // late traffic of a request that is no longer current
  if (message.type === 'chunk') { if (!job.cancelled) job.conn.send({ type: 'chunk', id: job.id, seq: message.seq, wav: message.wav, seconds: message.seconds }); armJobTimer(); return; }
  if (message.type === 'done') { if (!job.cancelled) job.conn.send({ type: 'done', id: job.id }); finishRunning(); return; }
  if (message.type === 'error') { if (!job.cancelled) job.conn.send({ type: 'error', id: job.id, message: typeof message.message === 'string' ? message.message.slice(0, 200) : 'synthesis failed' }); finishRunning(); }
}

// ---- lifetime (S13, L83) ------------------------------------------------------------------------------------------------------------------
/** Re-arms the grace countdown from the current state: it runs only while no client is connected, and ends with the Python unloaded and the service gone. */
function settle() {
  clearTimeout(exitTimer); exitTimer = undefined;
  const busy = running !== undefined || queue.length > 0;
  if (draining) { if (!busy) finalize(); return; }
  if (connections.size > 0) { graceStart = undefined; return; }
  graceStart ??= Date.now();
  if (busy || graceMs === null) return;
  exitTimer = setTimeout(() => {
    exitTimer = undefined;
    if (!running && queue.length === 0 && connections.size === 0 && graceStart !== undefined && Date.now() - graceStart >= graceMs - 5) { log('grace over: no clients, unloading Qwen and exiting'); shutdown(true); }
    else settle();
  }, Math.max(0, graceStart + graceMs - Date.now()));
}

function shutdown(now) {
  if (!draining) { draining = true; try { server?.close(); } catch { /* not listening */ } } // closing the server also removes the socket file
  if (now) {
    for (const job of [...queue.splice(0), ...(running ? [running] : [])]) if (!job.cancelled) job.conn.send({ type: 'error', id: job.id, message: 'Qwen service stopped.' });
    running = undefined;
    finalize();
  } else settle();
}
function finalize() {
  clearTimeout(jobTimer); clearInterval(heartbeat);
  killWorker();
  try { if (fs.readFileSync(pidPath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidPath); } catch { /* not ours or gone */ }
  for (const conn of connections) conn.socket.destroy();
  process.exit(0);
}

// ---- connections --------------------------------------------------------------------------------------------------------------------------
function onConnection(socket) {
  /** @type {Connection} */
  const conn = { socket, jobs: new Map(), closed: false, send(message) { if (!conn.closed && !socket.destroyed) socket.write(JSON.stringify({ schema: SCHEMA, ...message }) + '\n'); } };
  connections.add(conn); graceStart = undefined;
  settle();
  socket.setEncoding('utf8');
  socket.on('error', () => { /* handled by close */ });
  socket.on('close', () => {
    conn.closed = true; connections.delete(conn);
    for (const job of conn.jobs.values()) { job.cancelled = true; const at = queue.indexOf(job); if (at >= 0) queue.splice(at, 1); }
    conn.jobs.clear();
    settle();
  });
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > MAX_LINE * 2) { conn.send({ type: 'error', id: null, message: 'line too long' }); socket.destroy(); return; }
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (line.length > MAX_LINE) { conn.send({ type: 'error', id: null, message: 'line too long' }); socket.destroy(); return; }
      onRequest(conn, line);
    }
  });
  conn.send({ type: 'hello', version, ...(build ? { build } : {}), pid: process.pid });
}
function onRequest(conn, line) {
  let message;
  try { message = JSON.parse(line); } catch { conn.send({ type: 'error', id: null, message: 'invalid JSON' }); return; }
  if (message === null || typeof message !== 'object' || Array.isArray(message) || message.schema !== SCHEMA) { conn.send({ type: 'error', id: null, message: 'bad schema' }); return; }
  const id = Number.isSafeInteger(message.id) && message.id >= 0 ? message.id : null;
  if (message.type === 'shutdown') { shutdown(message.now === true); return; }
  if (message.type === 'cancel') {
    const job = id === null ? undefined : conn.jobs.get(id);
    if (!job) return;
    job.cancelled = true; conn.jobs.delete(job.id);
    const at = queue.indexOf(job); if (at >= 0) queue.splice(at, 1); // a running one is not preempted: its output is dropped
    settle();
    return;
  }
  if (message.type !== 'synth') { conn.send({ type: 'error', id, message: 'unknown type' }); return; }
  if (id === null) { conn.send({ type: 'error', id: null, message: 'bad id' }); return; }
  if (conn.jobs.has(id)) { conn.send({ type: 'error', id, message: 'duplicate id' }); return; }
  if (conn.jobs.size >= MAX_JOBS_PER_CONNECTION) { conn.send({ type: 'error', id, message: 'too many pending requests' }); return; }
  const reason = invalidSynth(message);
  if (reason) { conn.send({ type: 'error', id, message: `invalid request: ${reason}` }); return; }
  const job = { conn, id, priority: message.priority, request: message, internalId: nextInternalId++, cancelled: false };
  conn.jobs.set(id, job); queue.push(job);
  pump();
}

// ---- start --------------------------------------------------------------------------------------------------------------------------------
function probe() { // a live service already owns the socket?
  return new Promise(resolve => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
async function main() {
  ensurePrivateDir();
  if (fs.existsSync(socketPath)) {
    if (await probe()) { log('another service is already listening'); process.exit(0); }
    fs.unlinkSync(socketPath);
  }
  server = net.createServer(onConnection);
  server.on('error', error => { log('listen failed:', String(error)); process.exit(1); });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
    heartbeat = setInterval(() => { for (const job of queue) job.conn.send({ type: 'queued', id: job.id }); }, HEARTBEAT_MS);
    heartbeat.unref();
    log(`listening on ${socketPath} (version ${version}, build ${build ?? 'unknown'}, grace ${graceMs})`);
    settle();
  });
}
process.on('SIGTERM', () => shutdown(true));
process.on('SIGINT', () => shutdown(true));
process.on('uncaughtException', error => { log('fatal:', error?.stack ?? String(error)); try { killWorker(); } catch { /* best effort */ } process.exit(1); });
main().catch(error => { log('start failed:', String(error)); process.exit(1); });
