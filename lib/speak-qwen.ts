import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realHome } from './speak-home.ts';
import { QWEN_PYTHON_FLAGS } from './speak-voices.ts';

/**
 * Starts the Qwen Python worker (`python -E -P <script>`). `HOME` is the account's real home: Gentle Dot overrides `$HOME`, and
 * Python finds its user site-packages (where mlx-audio lives) through it. `-E` ignores PYTHON* vars, not `HOME`.
 * `HF_HOME` pins the real Hugging Face cache: Gentle Dot also sets `XDG_CACHE_HOME` under its own home, which huggingface_hub
 * prefers over `HOME`, so offline model loads missed the cache (L72). A user-set `HF_HOME` is kept.
 */
export function spawnQwenPython(python: string, script: string, io: { spawn?: typeof spawnChild; env?: NodeJS.ProcessEnv; home?: string } = {}): ChildProcessWithoutNullStreams {
  const run = io.spawn ?? spawnChild;
  return run(python, [...QWEN_PYTHON_FLAGS, script], { stdio: ['pipe', 'pipe', 'pipe'], env: qwenPythonEnv(io.env ?? process.env, io.home ?? realHome()) });
}

/** The environment of every Qwen Python process (T38: the shared service inherits exactly this one from the client that starts it). */
export function qwenPythonEnv(env: NodeJS.ProcessEnv = process.env, home: string = realHome()): NodeJS.ProcessEnv {
  return { ...env, HOME: home, HF_HOME: env.HF_HOME || join(home, '.cache', 'huggingface'), HF_HUB_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' };
}

/** Qwen3-TTS routing: a persistent Python synth worker feeds WAV chunks to the Node audio worker as `play`. */
export const QWEN_SCHEMA = 'gentle.speak.qwen/v1';
const AUDIO_SCHEMA = 'gentle.speak/v1';
const MAX_LINE = 16384;
/** Bounds model readiness: from spawning the synth worker until it reports `ready`. */
export const QWEN_READY_TIMEOUT_MS = 180_000;
/**
 * Bounds the wait for the next synthesis event (`chunk`, `warning`, or `done`) after `synth` was sent; every event re-arms it and
 * `done` disarms it. Playback is deliberately outside this bound: it is limited only by the audio worker's own per-chunk caps.
 */
export const QWEN_SYNTH_IDLE_TIMEOUT_MS = 120_000;

/** Default idle release of the warm worker (5 minutes); the extension passes the `qwenIdleMinutes` setting. */
export const QWEN_IDLE_MS = 5 * 60_000;

export type QwenChild = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'on' | 'kill'> & {
  /** T38: a service connection understands a `priority` ('speak' | 'prepare') on `synth` and `cancelRequest`; a plain worker does not. */
  hints?: boolean;
  /** T38: tells the shared service to drop a request (queued: never runs; running: its output is discarded). */
  cancelRequest?: (id: number) => void;
};
export interface QwenSpeechDeps {
  /** Starts `python -I <script>`; only called lazily, after the voice was verified installed. */
  spawnPython: (python: string) => QwenChild;
  /** Starts the Node audio worker (scripts/speak-worker.cjs). */
  spawnAudio: () => QwenChild;
  tmpRoot?: string;
  /** S13: close the warm Python worker after this many ms without activity; `null` never. Default {@link QWEN_IDLE_MS}. */
  idleMs?: number | null;
}
export interface QwenSpeakRequest {
  python: string; text: string; ref: string; refText: string; speed: number; runtime: string;
  onWarning?: (message: string) => void;
}
/** Synthesizes into WAV files without playing; `signal` cancels (queued or running) and deletes the files. */
export interface QwenPrepareRequest {
  python: string; text: string; ref: string; refText: string; speed: number;
  signal?: AbortSignal; onWarning?: (message: string) => void;
}
/** Plays `wavs` (from `prepare`) in order, then the parts of the still-running `inflight` prepare as they arrive, then synthesizes and plays `remainderText` (may be empty). */
export interface QwenSpeakPreparedRequest {
  python: string; wavs: readonly string[]; inflight?: QwenPrepareHandle; remainderText: string; ref: string; refText: string; speed: number; runtime: string;
  onWarning?: (message: string) => void;
}
export type QwenPrepareOutcome = { ok: true; wavs: string[] } | { ok: false; message: string; cancelled?: boolean };
/** A running `prepare`: its parts can be consumed while it is still synthesizing. */
export interface QwenPrepareHandle {
  /** Calls `listener` with every part so far (replay), then with each new part in order; returns an unsubscribe. */
  onPart(listener: (wav: string) => void): () => void;
  /** Settles like the `prepare` promise. */
  readonly done: Promise<QwenPrepareOutcome>;
  /** Cancels the synthesis and deletes its files (no effect once finished). */
  cancel(): void;
}
export type QwenPreparation = Promise<QwenPrepareOutcome> & { handle: QwenPrepareHandle };
export type QwenOutcome = { ok: true } | { ok: false; message: string; cancelled?: boolean };

/** The interpreter recorded in the installer's manifest.json, or undefined when it is missing or malformed. */
export function readQwenPython(home: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), 'utf8'));
    return typeof manifest?.python === 'string' && isAbsolute(manifest.python) ? manifest.python : undefined;
  } catch { return undefined; }
}

/** `Audio playback failed: <cause>.` from the audio worker's optional cause; bounded to 120 chars, control characters and path-like tokens removed. */
export function playbackFailure(cause: unknown): string {
  const text = typeof cause === 'string'
    ? cause.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\S*[\/\\]\S*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim().replace(/[.\s]+$/, '')
    : '';
  return text ? `Audio playback failed: ${text}.` : 'Audio playback failed.';
}

function lineReader(onLine: (line: string) => void, onOverflow: () => void) {
  let buffer = '';
  return (chunk: unknown) => {
    buffer += String(chunk);
    if (buffer.length > MAX_LINE * 4) { buffer = ''; onOverflow(); return; }
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (line.length > MAX_LINE) { onOverflow(); continue; }
      onLine(line);
    }
  };
}

export function createQwenSpeech(deps: QwenSpeechDeps) {
  let tmp: string | undefined;
  let python: { child: QwenChild; ready: boolean; handler?: (message: any) => void } | undefined;
  let audio: QwenChild | undefined;
  let cancelCurrent: (() => void) | undefined;
  let busy = false;
  let idleMs: number | null = deps.idleMs === undefined ? QWEN_IDLE_MS : deps.idleMs;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0, playId = 0;
  /** Prepared-WAV directories (one per finished or running `prepare`), kept apart from `tmp` so a `speak` never deletes them. */
  const prepDirs = new Set<string>();
  /** At most one `prepare` runs, never while a `speak` runs: the others wait here. */
  let activePrepare: PrepareJob | undefined;
  const prepareQueue: PrepareJob[] = [];
  const jobs = new WeakMap<QwenPrepareHandle, PrepareJob>();

  const removeTmp = () => { if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } tmp = undefined; } };
  const killPython = () => { const old = python; python = undefined; clearTimeout(idleTimer); idleTimer = undefined; try { old?.child.kill(); } catch { /* already gone */ } };
  /** Drops a worker (killing it) so its late exit never reaches the request that is replacing it. */
  const dropWorker = (old: NonNullable<typeof python> | undefined) => { if (!old) return; old.handler = undefined; if (python === old) python = undefined; try { old.child.kill(); } catch { /* already gone */ } };
  const inUse = () => busy || activePrepare !== undefined || prepareQueue.length > 0;
  /** S13: (re)starts the idle countdown when the warm worker is idle; a speak, speakPrepared or prepare that runs or waits disarms it. */
  function settleIdle() {
    clearTimeout(idleTimer); idleTimer = undefined;
    if (idleMs === null || !python || inUse()) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      const old = python;
      if (!old || inUse()) return;
      python = undefined; old.handler = undefined;
      try { old.child.stdin.end?.(); } catch { /* already closed */ }
      try { old.child.kill(); } catch { /* already gone */ }
    }, idleMs);
    idleTimer.unref?.();
  }
  /** Writes one line to the worker; a stdin that is already closed throws like a broken pipe so the callers can respawn. */
  const writeLine = (state: NonNullable<typeof python>, payload: object, priority?: 'speak' | 'prepare') => {
    const stdin: any = state.child.stdin;
    if (stdin.destroyed || stdin.writable === false) throw new Error('Qwen worker stdin is closed');
    state.child.stdin.write(JSON.stringify(priority && state.child.hints ? { ...payload, priority } : payload) + '\n');
  };
  /** T38: a request that will not be consumed is dropped at the shared service too (best effort; a plain worker has nothing to cancel). */
  const cancelRemote = (state: NonNullable<typeof python> | undefined, id: number) => { try { state?.child.cancelRequest?.(id); } catch { /* connection already gone */ } };
  const killAudio = () => { const old = audio; audio = undefined; try { old?.kill(); } catch { /* already gone */ } };
  const ensureTmp = () => {
    if (!tmp) { tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'gentle-speak-')); chmodSync(tmp, 0o700); }
    return tmp;
  };

  function startPython(path: string) {
    const child = deps.spawnPython(path);
    const state: NonNullable<typeof python> = { child, ready: false };
    python = state;
    const gone = () => { if (python === state) { python = undefined; settleIdle(); } state.handler?.({ type: 'exit' }); };
    child.on('error', gone);
    child.on('exit', gone);
    (child.stdin as any).on?.('error', () => { try { child.kill(); } catch { /* already gone */ } gone(); }); // EPIPE on a dead worker: mark it gone, never an unhandled error
    child.stderr?.on?.('data', () => { /* logs stay on stderr; drained so the pipe never blocks */ });
    child.stdout.on('data', lineReader(line => {
      let message: any;
      try { message = JSON.parse(line); } catch { state.handler?.({ type: 'invalid' }); return; }
      if (message?.schema !== QWEN_SCHEMA || typeof message.type !== 'string') { state.handler?.({ type: 'invalid' }); return; }
      if (message.type === 'ready') state.ready = true;
      state.handler?.(message);
    }, () => state.handler?.({ type: 'invalid' })));
    return state;
  }

  const dropPrepDir = (dir: string) => { prepDirs.delete(dir); try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  /** A queued prepare starts only when no speak and no other prepare is running. */
  function startNext() {
    if (busy || activePrepare) { settleIdle(); return; }
    prepareQueue.shift()?.start();
    settleIdle();
  }
  /** A speak has priority over speculation: every running or queued prepare is cancelled (its files deleted). */
  function cancelPrepares(keep?: PrepareJob) {
    const all = [...(activePrepare ? [activePrepare] : []), ...prepareQueue.splice(0)];
    for (const job of all) if (job !== keep) job.cancel(); // a kept job that was still queued is started by its adopter
  }

  /** Stops playback and drops queued chunks. A hard stop also kills the synth worker; it respawns lazily. */
  function stop(hard = true) {
    if (hard) cancelPrepares();
    const cancel = cancelCurrent; cancelCurrent = undefined; cancel?.();
    killAudio();
    if (hard || busy) killPython();
    busy = false;
    removeTmp();
    if (hard) for (const dir of [...prepDirs]) dropPrepDir(dir);
  }
  function dispose() { stop(true); clearTimeout(idleTimer); idleTimer = undefined; }
  function setIdleMs(ms: number | null) { idleMs = ms; settleIdle(); }

  function speak(request: QwenSpeakRequest): Promise<QwenOutcome> { return run(request, []); }

  function speakPrepared(request: QwenSpeakPreparedRequest): Promise<QwenOutcome> {
    const { wavs, remainderText, ...rest } = request;
    return run({ ...rest, text: remainderText.trim() }, wavs, request.inflight);
  }

  /** The shared utterance path: plays `initial` WAVs first, then synthesizes `request.text` unless it is empty (never for `speak`). */
  function run(request: QwenSpeakRequest & { inflight?: QwenPrepareHandle }, initial: readonly string[], inflight?: QwenPrepareHandle): Promise<QwenOutcome> {
    const adopted = inflight ? jobs.get(inflight) : undefined;
    clearTimeout(idleTimer); idleTimer = undefined;
    cancelPrepares(adopted); // an adopted prepare keeps running: its parts are played as they arrive
    stop(false); // supersede the previous utterance; keep an idle model loaded
    const dir = ensureTmp();
    const id = ++requestId;
    busy = true;
    return new Promise<QwenOutcome>(resolve => {
      const pending = new Map<number, string>();
      let settled = false, synthDone = false, nextSeq = 0;
      let readyTimer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined;
      const synthesizes = (initial.length === 0 && !inflight) || request.text !== '';
      const preparedDirs = new Set(initial.map(wav => dirname(wav)).filter(dir => prepDirs.has(dir)));
      let worker!: NonNullable<typeof python>;
      let unsubscribe: (() => void) | undefined, inflightDone = false;
      try { if (synthesizes && !inflight) worker = python ?? startPython(request.python); }
      catch { busy = false; removeTmp(); for (const wav of initial) rmSync(wav, { force: true }); preparedDirs.forEach(dropPrepDir); resolve({ ok: false, message: 'Qwen worker could not start.' }); startNext(); return; }
      const finish = (outcome: QwenOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(readyTimer);
        if (sent && !synthDone && worker) cancelRemote(worker, id);
        if (worker) worker.handler = undefined;
        unsubscribe?.();
        if (inflight && !inflightDone) inflight.cancel(); // an unfinished adopted prepare dies with its utterance
        if (cancelCurrent === cancel) cancelCurrent = undefined;
        for (const wav of pending.values()) rmSync(wav, { force: true });
        pending.clear();
        killAudio();
        busy = false;
        if (!outcome.ok && !outcome.cancelled) killPython(); // a failed worker is never reused
        preparedDirs.forEach(dropPrepDir);
        resolve(outcome);
        startNext();
      };
      const cancel = () => finish({ ok: false, message: 'Speech cancelled.', cancelled: true });
      cancelCurrent = cancel;
      const disarmIdle = () => { clearTimeout(idleTimer); idleTimer = undefined; };
      const armIdle = () => { disarmIdle(); idleTimer = setTimeout(() => finish({ ok: false, message: 'Qwen worker timed out.' }), QWEN_SYNTH_IDLE_TIMEOUT_MS); };
      const maybeDone = () => { if (synthDone && pending.size === 0) finish({ ok: true }); };

      const ensureAudio = () => {
        if (audio) return audio;
        const child = deps.spawnAudio();
        audio = child;
        child.on('error', () => { if (audio === child) finish({ ok: false, message: 'Audio worker failed.' }); });
        child.on('exit', () => { if (audio === child) finish({ ok: false, message: 'Audio worker exited before playback finished.' }); });
        child.stdout.on('data', lineReader(line => {
          let reply: any;
          try { reply = JSON.parse(line); } catch { finish({ ok: false, message: 'Invalid audio worker response.' }); return; }
          if (reply?.schema !== AUDIO_SCHEMA) { finish({ ok: false, message: 'Invalid audio worker response.' }); return; }
          if (reply.type === 'done' && pending.has(reply.id)) {
            rmSync(pending.get(reply.id)!, { force: true });
            pending.delete(reply.id);
            maybeDone();
          } else if (reply.type === 'error') finish({ ok: false, message: playbackFailure(reply.cause) });
        }, () => finish({ ok: false, message: 'Invalid audio worker response.' })));
        return child;
      };
      const play = (wav: string) => {
        const pid = ++playId;
        pending.set(pid, wav);
        try { ensureAudio().stdin.write(JSON.stringify({ schema: AUDIO_SCHEMA, type: 'play', id: pid, wav, speed: 1, runtime: request.runtime }) + '\n'); }
        catch { finish({ ok: false, message: 'Audio worker input failed.' }); }
      };
      let retried = false, warm = false, sent = false;
      const sendSynth = () => {
        armIdle();
        try {
          writeLine(worker, { schema: QWEN_SCHEMA, type: 'synth', id, text: request.text, ref: request.ref, refText: request.refText, outDir: dir, speed: request.speed }, 'speak');
          sent = true;
        } catch {
          // S13: a warm worker that died while idle (EPIPE): respawn once, before this request starts.
          if (retried || !warm) { finish({ ok: false, message: 'Qwen worker input failed.' }); return; }
          retried = true; disarmIdle();
          dropWorker(worker);
          try { worker = startPython(request.python); } catch { finish({ ok: false, message: 'Qwen worker could not start.' }); return; }
          beginSynth();
        }
      };
      function handle(message: any) {
        if (settled) return;
        // Late traffic of a cancelled/superseded request (the warm worker keeps synthesizing it): ids already issued but not current.
        if ((message.type === 'chunk' || message.type === 'done' || message.type === 'error') && Number.isSafeInteger(message.id) && message.id >= 1 && message.id < id) return;
        switch (message.type) {
          case 'ready': sendSynth(); break;
          case 'warning': armIdle(); if (typeof message.message === 'string') request.onWarning?.(message.message.slice(0, 200)); break;
          case 'chunk':
            if (message.id !== id || message.seq !== nextSeq || typeof message.wav !== 'string' || !isAbsolute(message.wav) || dirname(message.wav) !== dir) { finish({ ok: false, message: 'Invalid Qwen worker response.' }); break; }
            nextSeq++; armIdle(); play(message.wav); break;
          case 'done':
            if (message.id !== id) { finish({ ok: false, message: 'Invalid Qwen worker response.' }); break; }
            synthDone = true; disarmIdle(); maybeDone(); break;
          case 'error': finish({ ok: false, message: message.id === null || message.id === id ? 'Qwen synthesis failed. Check that mlx-audio and the model are installed (see README, "Qwen voices").' : 'Invalid Qwen worker response.' }); break;
          case 'exit': finish({ ok: false, message: 'Qwen worker exited before speech finished.' }); break;
          default: finish({ ok: false, message: 'Invalid Qwen worker response.' });
        }
      }
      const beginSynth = () => {
        warm = worker.ready && !retried;
        worker.handler = handle;
        if (worker.ready) sendSynth();
        else {
          readyTimer = setTimeout(() => finish({ ok: false, message: 'Qwen worker did not become ready.' }), QWEN_READY_TIMEOUT_MS);
          worker.handler = message => { if (message.type === 'ready') clearTimeout(readyTimer); handle(message); };
        }
      };
      if (!synthesizes) {
        synthDone = true;
        for (const wav of initial) play(wav);
        if (!inflight) { maybeDone(); return; }
      } else for (const wav of initial) play(wav);
      if (inflight) {
        // Strict order: finished WAVs, then each part of the in-flight sentence as it arrives, then the remainder once the worker is free.
        if (adopted && !adopted.started && !adopted.settled) { const queued = prepareQueue.indexOf(adopted); if (queued >= 0) prepareQueue.splice(queued, 1); adopted.start(); }
        unsubscribe = inflight.onPart(wav => { if (!settled) { const dir = dirname(wav); if (prepDirs.has(dir)) preparedDirs.add(dir); play(wav); } });
        inflight.done.then(outcome => {
          inflightDone = true;
          if (settled) return;
          if (!outcome.ok) { finish({ ok: false, message: outcome.message, cancelled: outcome.cancelled }); return; }
          unsubscribe?.();
          if (!synthesizes) { maybeDone(); return; }
          try { worker = python ?? startPython(request.python); } catch { finish({ ok: false, message: 'Qwen worker could not start.' }); return; }
          beginSynth();
        });
        return;
      }
      beginSynth();
    });
  }

  interface PrepareJob { start: () => void; cancel: () => void; started?: boolean; settled?: boolean }

  /** Synthesizes into WAV files without playing, through the same warm worker and per-part streaming. */
  function prepare(request: QwenPrepareRequest): QwenPreparation {
    let handle!: QwenPrepareHandle;
    const promise = new Promise<QwenPrepareOutcome>(resolve => {
      let settled = false, nextSeq = 0, dir: string | undefined;
      let readyTimer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined;
      let worker: NonNullable<typeof python> | undefined, remoteId: number | undefined;
      const wavs: string[] = [];
      const listeners = new Set<(wav: string) => void>();
      const job: PrepareJob = { start, cancel: () => finish({ ok: false, message: 'Speech cancelled.', cancelled: true }) };
      handle = {
        onPart(listener) { for (const wav of wavs) listener(wav); listeners.add(listener); return () => { listeners.delete(listener); }; },
        get done() { return promise; },
        cancel: () => job.cancel(),
      };
      jobs.set(handle, job);
      const finish = (outcome: QwenPrepareOutcome) => {
        if (settled) return;
        settled = true; job.settled = true;
        listeners.clear();
        clearTimeout(idleTimer); clearTimeout(readyTimer);
        request.signal?.removeEventListener('abort', job.cancel);
        if (!outcome.ok && remoteId !== undefined) cancelRemote(worker, remoteId);
        if (worker) worker.handler = undefined;
        const queued = prepareQueue.indexOf(job); if (queued >= 0) prepareQueue.splice(queued, 1);
        if (!outcome.ok) {
          if (dir) dropPrepDir(dir); // an unusable prepare leaves no files behind
          if (!outcome.cancelled) killPython(); // a failed worker is never reused
        }
        if (activePrepare === job) activePrepare = undefined;
        resolve(outcome);
        startNext();
      };
      const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => finish({ ok: false, message: 'Qwen worker timed out.' }), QWEN_SYNTH_IDLE_TIMEOUT_MS); };
      function start() {
        if (settled) return;
        job.started = true;
        activePrepare = job;
        const id = ++requestId;
        try {
          dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'gentle-speak-prep-'));
          chmodSync(dir, 0o700); prepDirs.add(dir);
          worker = python ?? startPython(request.python);
        } catch { finish({ ok: false, message: 'Qwen worker could not start.' }); return; }
        const outDir = dir;
        let state = worker, retried = false, warm = false;
        const sendSynth = () => {
          armIdle();
          try { writeLine(state, { schema: QWEN_SCHEMA, type: 'synth', id, text: request.text, ref: request.ref, refText: request.refText, outDir, speed: request.speed }, 'prepare'); remoteId = id; }
          catch {
            // S13: a warm worker that died while idle (EPIPE): respawn once, before this prepare starts.
            if (retried || !warm) { finish({ ok: false, message: 'Qwen worker input failed.' }); return; }
            retried = true; clearTimeout(idleTimer);
            dropWorker(state);
            try { worker = state = startPython(request.python); } catch { finish({ ok: false, message: 'Qwen worker could not start.' }); return; }
            begin();
          }
        };
        const handle = (message: any) => {
          if (settled) return;
          if ((message.type === 'chunk' || message.type === 'done' || message.type === 'error') && Number.isSafeInteger(message.id) && message.id >= 1 && message.id < id) return;
          switch (message.type) {
            case 'ready': clearTimeout(readyTimer); sendSynth(); break;
            case 'warning': armIdle(); if (typeof message.message === 'string') request.onWarning?.(message.message.slice(0, 200)); break;
            case 'chunk':
              if (message.id !== id || message.seq !== nextSeq || typeof message.wav !== 'string' || !isAbsolute(message.wav) || dirname(message.wav) !== outDir) { finish({ ok: false, message: 'Invalid Qwen worker response.' }); break; }
              nextSeq++; armIdle(); wavs.push(message.wav); for (const listener of [...listeners]) listener(message.wav); break;
            case 'done':
              if (message.id !== id) { finish({ ok: false, message: 'Invalid Qwen worker response.' }); break; }
              clearTimeout(idleTimer); finish({ ok: true, wavs: [...wavs] }); break;
            case 'error': finish({ ok: false, message: message.id === null || message.id === id ? 'Qwen synthesis failed. Check that mlx-audio and the model are installed (see README, "Qwen voices").' : 'Invalid Qwen worker response.' }); break;
            case 'exit': finish({ ok: false, message: 'Qwen worker exited before speech finished.' }); break;
            default: finish({ ok: false, message: 'Invalid Qwen worker response.' });
          }
        };
        const begin = () => {
          warm = state.ready && !retried;
          state.handler = handle;
          if (state.ready) sendSynth();
          else readyTimer = setTimeout(() => finish({ ok: false, message: 'Qwen worker did not become ready.' }), QWEN_READY_TIMEOUT_MS);
        };
        begin();
      }
      if (request.signal?.aborted) { resolve({ ok: false, message: 'Speech cancelled.', cancelled: true }); return; }
      request.signal?.addEventListener('abort', job.cancel, { once: true });
      prepareQueue.push(job);
      startNext();
    });
    return Object.assign(promise, { handle });
  }

  /** Deletes prepared WAVs that will never play (and their directory once empty). */
  function discard(wavs: readonly string[]) {
    for (const wav of wavs) {
      rmSync(wav, { force: true });
      const dir = dirname(wav);
      if (prepDirs.has(dir)) { try { if (readdirSync(dir).length === 0) dropPrepDir(dir); } catch { /* already gone */ } }
    }
  }

  return { speak, stop, dispose, prepare, speakPrepared, discard, setIdleMs };
}
