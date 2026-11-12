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
import { EventEmitter } from 'node:events';
import { connectQwenService, QWEN_SERVICE_SCHEMA, type QwenServiceConnection, type QwenServiceOptions } from './speak-qwen-service.ts';
import type { QwenChild } from './speak-qwen.ts';

// T38 (S13): a "worker" for createQwenSpeech that is a connection to the shared Qwen service. It speaks the Python worker's protocol
// (`gentle.speak.qwen/v1`) to the engine and the service protocol to the socket, so the engine does not know the difference. When the
// service cannot be started or reached it becomes a local per-session worker (T37 behavior), logged once, never a failure.
//
// Presence (S13, L83): the spawner owns ONE service connection per session, opened at the first speech and kept until `close()` (session shutdown or /reload).
// The "workers" it hands the engine are views over that connection: killing one (T37 idle, a hard stop) only cancels its requests, never the socket, so the
// service sees the session as present and keeps the model loaded. If the connection drops (service stopped, replaced or killed) the next need reconnects,
// starting the service once if needed. Reconnecting at the next need rather than in the background is deliberate: a background reconnect would undo
// «Detener servicio Qwen» and a version replacement at once, and would restart a service nobody asked for; the cost is one model load on the next speech.
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

/** A spawner is a `spawnPython` for {@link createQwenSpeech} plus `close()`, which ends the session's presence connection. */
export type QwenServiceSpawner = ((python: string) => QwenChild) & { close: () => void };

interface Link { socket: QwenServiceConnection['socket']; children: Set<View>; owners: Map<number, View> }
interface View { onMessage: (message: any) => void; onInvalid: () => void; onDrop: () => void }

/** Returns a `spawnPython` for {@link createQwenSpeech}: every call is a new view over the session's one connection (or a local fallback worker). */
export function createQwenServiceSpawner(options: QwenServiceSpawnerOptions): QwenServiceSpawner {
  let reported = false, closedAll = false;
  const connect = options.connect ?? connectQwenService;
  let link: Link | undefined;
  let linking: Promise<Link> | undefined;

  const dropLink = (dead: Link) => { if (link === dead) link = undefined; for (const view of [...dead.children]) view.onDrop(); dead.children.clear(); dead.owners.clear(); };
  const getLink = (python: string): Promise<Link> => {
    if (link && !link.socket.destroyed) return Promise.resolve(link);
    link = undefined;
    linking ??= connect({ ...options, idleMs: typeof options.idleMs === 'function' ? options.idleMs() : options.idleMs, python }).then(connection => {
      linking = undefined;
      if (closedAll) { connection.socket.destroy(); throw new Error('session closed'); }
      const made: Link = { socket: connection.socket, children: new Set(), owners: new Map() };
      link = made;
      let buffer = '';
      const route = (line: string) => {
        let message: any;
        try { message = JSON.parse(line); } catch { for (const view of made.children) view.onInvalid(); return; }
        if (message?.schema !== QWEN_SERVICE_SCHEMA) { for (const view of made.children) view.onInvalid(); return; }
        const owner = Number.isSafeInteger(message.id) ? made.owners.get(message.id) : undefined;
        if (owner) { owner.onMessage(message); if (message.type === 'done' || message.type === 'error') made.owners.delete(message.id); }
      };
      const feed = (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE * 4) { buffer = ''; for (const view of made.children) view.onInvalid(); return; }
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.length <= MAX_LINE) route(line); else for (const view of made.children) view.onInvalid(); }
      };
      connection.socket.on('data', feed);
      connection.socket.on('close', () => dropLink(made));
      connection.socket.on('error', () => { /* close follows */ });
      if (connection.rest) feed(connection.rest);
      return made;
    }, error => { linking = undefined; throw error; });
    return linking;
  };

  const spawner = ((python: string) => {
    const stdout = new EventEmitter(), stderr = new EventEmitter();
    let mode: 'connecting' | 'service' | 'local' | 'closed' = 'connecting';
    let attached: Link | undefined;
    let local: QwenChild | undefined;
    let exited = false;
    const mine = new Set<number>();
    const queued: string[] = [];
    const child: any = new EventEmitter();
    const emitExit = () => { if (exited) return; exited = true; mode = 'closed'; child.emit('exit', null, null); };
    const toEngine = (message: object) => stdout.emit('data', JSON.stringify({ schema: WORKER_SCHEMA, ...message }) + '\n');
    const toService = (message: object) => { if (attached && !attached.socket.destroyed) attached.socket.write(JSON.stringify({ schema: QWEN_SERVICE_SCHEMA, ...message }) + '\n'); };

    /** Engine -> service: the worker's `synth` becomes a service request carrying its priority hint. */
    const forward = (line: string) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message?.text === 'string') message.text = message.text.replace(/\r\n?/g, '\n').replace(/[\x0b\x0c]/g, ' '); // mirrors the service's normalization
      if (mode === 'local') {
        if (message?.priority !== undefined) delete message.priority;
        local!.stdin.write(JSON.stringify(message) + '\n');
        return;
      }
      if (message?.type !== 'synth') return; // `shutdown`: ending this view is the equivalent
      if (Number.isSafeInteger(message.id)) { mine.add(message.id); attached?.owners.set(message.id, view); }
      toService({ type: 'synth', id: message.id, priority: message.priority === 'prepare' ? 'prepare' : 'speak', text: message.text, ref: message.ref, refText: message.refText, outDir: message.outDir, speed: message.speed });
    };

    /** Service -> engine (only this view's requests reach it). */
    const view: View = {
      onMessage(message) {
        switch (message.type) {
          case 'chunk': toEngine({ type: 'chunk', id: message.id, seq: message.seq, wav: message.wav, seconds: message.seconds }); break;
          case 'done': mine.delete(message.id); toEngine({ type: 'done', id: message.id }); break;
          case 'error': mine.delete(message.id); toEngine({ type: 'error', id: message.id, message: typeof message.message === 'string' ? message.message : 'synthesis failed' }); break;
          case 'warning': toEngine({ type: 'warning', ...(typeof message.message === 'string' ? { message: message.message } : {}) }); break;
          case 'queued': toEngine({ type: 'warning' }); break; // heartbeat while waiting behind other sessions: re-arms the engine's idle bound
          default: break;
        }
      },
      onInvalid() { if (mode === 'service') toEngine({ type: 'invalid' }); },
      onDrop() { attached = undefined; emitExit(); },
    };

    const useService = (connected: Link) => {
      if (mode === 'closed') return;
      mode = 'service';
      attached = connected;
      connected.children.add(view);
      toEngine({ type: 'ready' });
      for (const line of queued.splice(0)) forward(line);
    };

    const useLocal = (reason: string) => {
      if (mode === 'closed') return;
      if (!reported && !closedAll) { reported = true; try { options.onFallback?.(reason); } catch { /* logging never fails speech */ } }
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
      // a closed view must read as a closed stdin to the engine's writeLine check (EPIPE-like: it respawns once)
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
      if (was === 'service' && attached) {
        for (const id of mine) { toService({ type: 'cancel', id }); attached.owners.delete(id); } // the connection stays: it is the session's presence
        mine.clear(); attached.children.delete(view); attached = undefined;
      }
      else if (was === 'local') { try { local?.stdin.end?.(); } catch { /* closed */ } try { local?.kill(); } catch { /* gone */ } }
      // 'connecting': the pending connect finds this view closed and attaches nothing
      if (!exited) { exited = true; child.emit('exit', null, null); }
    };
    Object.assign(child, {
      stdin, stdout, stderr, hints: true,
      kill() { close(); return true; },
      cancelRequest(id: number) { if (mode === 'service' && mine.has(id)) { toService({ type: 'cancel', id }); mine.delete(id); attached?.owners.delete(id); } },
    });

    Object.defineProperty(child, 'persistent', { get: () => mode === 'service' || mode === 'connecting' });
    Promise.resolve().then(() => getLink(python)).then(useService, error => useLocal(String((error as Error)?.message ?? error)));
    return child as QwenChild;
  }) as QwenServiceSpawner;

  spawner.close = () => {
    closedAll = true;
    const current = link; link = undefined;
    if (current) { for (const view of [...current.children]) view.onDrop(); current.children.clear(); current.owners.clear(); try { current.socket.end(); } catch { /* gone */ } current.socket.destroy(); }
  };
  return spawner;
}
