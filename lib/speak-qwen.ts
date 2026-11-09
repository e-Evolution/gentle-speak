import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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

export type QwenChild = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'on' | 'kill'>;
export interface QwenSpeechDeps {
  /** Starts `python -I <script>`; only called lazily, after the voice was verified installed. */
  spawnPython: (python: string) => QwenChild;
  /** Starts the Node audio worker (scripts/speak-worker.cjs). */
  spawnAudio: () => QwenChild;
  tmpRoot?: string;
}
export interface QwenSpeakRequest {
  python: string; text: string; ref: string; refText: string; speed: number; runtime: string;
  onWarning?: (message: string) => void;
}
export type QwenOutcome = { ok: true } | { ok: false; message: string; cancelled?: boolean };

/** The interpreter recorded in the installer's manifest.json, or undefined when it is missing or malformed. */
export function readQwenPython(home: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(home, 'voices', 'qwen3', 'manifest.json'), 'utf8'));
    return typeof manifest?.python === 'string' && isAbsolute(manifest.python) ? manifest.python : undefined;
  } catch { return undefined; }
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
  let requestId = 0, playId = 0;

  const removeTmp = () => { if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } tmp = undefined; } };
  const killPython = () => { const old = python; python = undefined; try { old?.child.kill(); } catch { /* already gone */ } };
  const killAudio = () => { const old = audio; audio = undefined; try { old?.kill(); } catch { /* already gone */ } };
  const ensureTmp = () => {
    if (!tmp) { tmp = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'gentle-speak-')); chmodSync(tmp, 0o700); }
    return tmp;
  };

  function startPython(path: string) {
    const child = deps.spawnPython(path);
    const state: NonNullable<typeof python> = { child, ready: false };
    python = state;
    const gone = () => { if (python === state) python = undefined; state.handler?.({ type: 'exit' }); };
    child.on('error', gone);
    child.on('exit', gone);
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

  /** Stops playback and drops queued chunks. A hard stop also kills the synth worker; it respawns lazily. */
  function stop(hard = true) {
    const cancel = cancelCurrent; cancelCurrent = undefined; cancel?.();
    killAudio();
    if (hard || busy) killPython();
    busy = false;
    removeTmp();
  }
  function dispose() { stop(true); }

  function speak(request: QwenSpeakRequest): Promise<QwenOutcome> {
    stop(false); // supersede the previous utterance; keep an idle model loaded
    const dir = ensureTmp();
    const id = ++requestId;
    busy = true;
    return new Promise<QwenOutcome>(resolve => {
      const pending = new Map<number, string>();
      let settled = false, synthDone = false, nextSeq = 0;
      let readyTimer: ReturnType<typeof setTimeout> | undefined, idleTimer: ReturnType<typeof setTimeout> | undefined;
      let worker: NonNullable<typeof python>;
      try { worker = python ?? startPython(request.python); }
      catch { busy = false; removeTmp(); resolve({ ok: false, message: 'Qwen worker could not start.' }); return; }
      const finish = (outcome: QwenOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(readyTimer);
        worker.handler = undefined;
        if (cancelCurrent === cancel) cancelCurrent = undefined;
        for (const wav of pending.values()) rmSync(wav, { force: true });
        pending.clear();
        killAudio();
        busy = false;
        if (!outcome.ok && !outcome.cancelled) killPython(); // a failed worker is never reused
        resolve(outcome);
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
          } else if (reply.type === 'error') finish({ ok: false, message: 'Audio playback failed.' });
        }, () => finish({ ok: false, message: 'Invalid audio worker response.' })));
        return child;
      };
      const play = (wav: string) => {
        const pid = ++playId;
        pending.set(pid, wav);
        try { ensureAudio().stdin.write(JSON.stringify({ schema: AUDIO_SCHEMA, type: 'play', id: pid, wav, speed: 1, runtime: request.runtime }) + '\n'); }
        catch { finish({ ok: false, message: 'Audio worker input failed.' }); }
      };
      const sendSynth = () => {
        armIdle();
        try {
          worker.child.stdin.write(JSON.stringify({ schema: QWEN_SCHEMA, type: 'synth', id, text: request.text, ref: request.ref, refText: request.refText, outDir: dir, speed: request.speed }) + '\n');
        } catch { finish({ ok: false, message: 'Qwen worker input failed.' }); }
      };
      function handle(message: any) {
        if (settled) return;
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
      worker.handler = handle;
      if (worker.ready) sendSynth();
      else {
        readyTimer = setTimeout(() => finish({ ok: false, message: 'Qwen worker did not become ready.' }), QWEN_READY_TIMEOUT_MS);
        worker.handler = message => { if (message.type === 'ready') clearTimeout(readyTimer); handle(message); };
      }
    });
  }

  return { speak, stop, dispose };
}
