import { EventEmitter } from 'node:events';
import { connectQwenService, QWEN_SERVICE_SCHEMA, type QwenServiceConnection, type QwenServiceOptions } from './speak-qwen-service.ts';
import type { QwenChild } from './speak-qwen.ts';

// T38 (S13): a "worker" for createQwenSpeech that is a connection to the shared Qwen service. It speaks the Python worker's protocol
// (`gentle.speak.qwen/v1`) to the engine and the service protocol to the socket, so the engine does not know the difference. When the
// service cannot be started or reached it becomes a local per-session worker (T37 behavior), logged once, never a failure.
const WORKER_SCHEMA = 'gentle.speak.qwen/v1';
const MAX_LINE = 65536;

export interface QwenServiceSpawnerOptions extends Omit<QwenServiceOptions, 'python' | 'idleMs'> {
  /** S13 idle close of the service's worker (ms; `null` never), read each time a connection is made, so a settings change reaches the next service start. */
  idleMs: number | null | (() => number | null);
  /** The T37 per-session worker, used when the service cannot run. */
  spawnLocal: (python: string) => QwenChild;
  /** Called once per spawner (process) with the reason the service could not be used. */
  onFallback?: (reason: string) => void;
  /** Tests: replaces the connect-or-start step. */
  connect?: (options: QwenServiceOptions) => Promise<QwenServiceConnection>;
}

/** Returns a `spawnPython` for {@link createQwenSpeech}: every call is one new connection (or local fallback worker). */
export function createQwenServiceSpawner(options: QwenServiceSpawnerOptions): (python: string) => QwenChild {
  let reported = false;
  const connect = options.connect ?? connectQwenService;
  return (python: string) => {
    const stdout = new EventEmitter(), stderr = new EventEmitter();
    let mode: 'connecting' | 'service' | 'local' | 'closed' = 'connecting';
    let socket: QwenServiceConnection['socket'] | undefined;
    let local: QwenChild | undefined;
    let exited = false;
    const queued: string[] = [];
    const child: any = new EventEmitter();
    const emitExit = () => { if (exited) return; exited = true; mode = 'closed'; child.emit('exit', null, null); };
    const toEngine = (message: object) => stdout.emit('data', JSON.stringify({ schema: WORKER_SCHEMA, ...message }) + '\n');
    const toService = (message: object) => { if (socket && !socket.destroyed) socket.write(JSON.stringify({ schema: QWEN_SERVICE_SCHEMA, ...message }) + '\n'); };

    /** Engine -> service: the worker's `synth` becomes a service request carrying its priority hint. */
    const forward = (line: string) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (mode === 'local') {
        if (message?.priority !== undefined) delete message.priority;
        local!.stdin.write(JSON.stringify(message) + '\n');
        return;
      }
      if (message?.type !== 'synth') return; // `shutdown`: closing the connection is the equivalent
      toService({ type: 'synth', id: message.id, priority: message.priority === 'prepare' ? 'prepare' : 'speak', text: message.text, ref: message.ref, refText: message.refText, outDir: message.outDir, speed: message.speed });
    };

    /** Service -> engine. */
    const fromService = (line: string) => {
      let message: any;
      try { message = JSON.parse(line); } catch { toEngine({ type: 'invalid' }); return; }
      if (message?.schema !== QWEN_SERVICE_SCHEMA) { toEngine({ type: 'invalid' }); return; }
      switch (message.type) {
        case 'chunk': toEngine({ type: 'chunk', id: message.id, seq: message.seq, wav: message.wav, seconds: message.seconds }); break;
        case 'done': toEngine({ type: 'done', id: message.id }); break;
        case 'error': toEngine({ type: 'error', id: message.id, message: typeof message.message === 'string' ? message.message : 'synthesis failed' }); break;
        case 'warning': toEngine({ type: 'warning', ...(typeof message.message === 'string' ? { message: message.message } : {}) }); break;
        case 'queued': toEngine({ type: 'warning' }); break; // heartbeat while waiting behind other sessions: re-arms the engine's idle bound
        default: break;
      }
    };

    const useService = (connection: QwenServiceConnection) => {
      if (mode === 'closed') { connection.socket.destroy(); return; }
      mode = 'service';
      socket = connection.socket;
      let buffer = '';
      const feed = (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE * 4) { buffer = ''; toEngine({ type: 'invalid' }); return; }
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.length <= MAX_LINE) fromService(line); else toEngine({ type: 'invalid' }); }
      };
      socket.on('data', feed);
      socket.on('close', emitExit);
      socket.on('error', () => { /* close follows */ });
      if (connection.rest) feed(connection.rest);
      toEngine({ type: 'ready' });
      for (const line of queued.splice(0)) forward(line);
    };

    const useLocal = (reason: string) => {
      if (mode === 'closed') return;
      if (!reported) { reported = true; try { options.onFallback?.(reason); } catch { /* logging never fails speech */ } }
      mode = 'local';
      try {
        const worker = options.spawnLocal(python);
        local = worker;
        worker.stdout.on('data', (data: unknown) => stdout.emit('data', data));
        worker.stderr?.on?.('data', (data: unknown) => stderr.emit('data', data));
        worker.on('error', (error: unknown) => { exited = true; mode = 'closed'; child.emit('error', error); });
        worker.on('exit', emitExit);
        (worker.stdin as any).on?.('error', () => { /* the exit handler reports it */ });
        for (const line of queued.splice(0)) forward(line);
      } catch (error) { exited = true; mode = 'closed'; child.emit('error', error); }
    };

    const stdin = {
      // a closed connection must read as a closed stdin to the engine's writeLine check (EPIPE-like: it respawns once)
      get destroyed() { return mode === 'closed'; },
      get writable() { return mode !== 'closed'; },
      on() { return stdin; },
      write(line: string) {
        if (mode === 'closed') throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        if (mode === 'connecting') { queued.push(String(line)); return true; }
        forward(String(line));
        return true;
      },
      end() { close(); },
    };
    const close = () => {
      const was = mode;
      mode = 'closed';
      queued.length = 0;
      if (was === 'service') socket?.destroy();
      else if (was === 'local') { try { local?.stdin.end?.(); } catch { /* closed */ } try { local?.kill(); } catch { /* gone */ } }
      // 'connecting': the pending connect closes its socket when it lands
      if (!exited) { exited = true; child.emit('exit', null, null); }
    };
    Object.assign(child, {
      stdin, stdout, stderr, hints: true,
      kill() { close(); return true; },
      cancelRequest(id: number) { if (mode === 'service') toService({ type: 'cancel', id }); },
    });

    Promise.resolve().then(() => connect({ ...options, idleMs: typeof options.idleMs === 'function' ? options.idleMs() : options.idleMs, python })).then(useService, error => useLocal(String((error as Error)?.message ?? error)));
    return child as QwenChild;
  };
}
