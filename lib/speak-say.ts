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
/** macOS system voice: speaks through `/usr/bin/say`, text on stdin only. Everything is injectable for tests. */
import { execFile, spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';

export const SAY_PATH = '/usr/bin/say';
/** Words per minute at speed 1. */
export const SAY_BASE_RATE = 185;
/** A voice name as `say` lists it: letters, digits, spaces and a few separators. */
export const MAC_VOICE_NAME = /^[\p{L}\p{N} ._()'-]{1,64}$/u;

export interface MacVoice { name: string; locale: string }
export interface SayChild {
  stdin: { write(chunk: string): unknown; end(): unknown; on?(event: 'error', listener: () => void): unknown };
  on(event: 'exit' | 'error', listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export type SaySpawn = (file: string, args: string[], options?: { env?: Record<string, string> }) => SayChild;
export interface SayOutcome { ok: boolean; message: string; cancelled?: boolean }

/** `Paulina             es_MX    # Hola…` and `Eddy (Español (México)) es_MX    # …`: the locale is the last token before `#`. */
export function parseSayVoices(output: string): MacVoice[] {
  const seen = new Set<string>();
  const voices: MacVoice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\s+([a-z]{2}_[A-Za-z]{2,})\s+#/.exec(line);
    if (!match || !match[2].startsWith('es_')) continue;
    const name = match[1].trim();
    const key = `${name}\u0000${match[2]}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    voices.push({ name, locale: match[2] });
  }
  return voices;
}

const runSayList = () => new Promise<string>((resolve, reject) => {
  execFile(SAY_PATH, ['-v', '?'], { timeout: 5000, maxBuffer: 1 << 20, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Installed Spanish voices; an empty list when `say` cannot be run. */
export async function listSpanishSayVoices(run: () => Promise<string> = runSayList): Promise<MacVoice[]> {
  try { return parseSayVoices(await run()); } catch { return []; }
}

/** `preferred` when installed, else Paulina (es_MX), Mónica (es_ES), the first es_MX, the first es_*. */
export function pickMacVoice(voices: readonly MacVoice[], preferred?: string | null): string | undefined {
  if (preferred && voices.some(voice => voice.name === preferred)) return preferred;
  // macOS lists some voices with a suffix (`Paulina (Español (México)) es_MX`): the base name decides, the listed name is returned.
  const base = (voice: MacVoice) => voice.name.replace(/\s*\(.*$/, '');
  return (voices.find(voice => base(voice) === 'Paulina' && voice.locale === 'es_MX')
    ?? voices.find(voice => base(voice) === 'Mónica' && voice.locale === 'es_ES')
    ?? voices.find(voice => voice.locale === 'es_MX')
    ?? voices.find(voice => voice.locale.startsWith('es_')))?.name;
}

export function sayAvailable(platform: string = process.platform, exists: (path: string) => boolean = existsSync): boolean {
  return platform === 'darwin' && exists(SAY_PATH);
}

/** Proportional to the text length (slower speeds take longer), with a fixed start-up allowance. */
export const sayTimeoutMs = (text: string, speed: number): number => 10_000 + Math.ceil(text.length * 120 / Math.max(speed, 0.5));

export const defaultSpawn: SaySpawn = (file, args, options) => spawnChild(file, args, { stdio: ['pipe', 'ignore', 'ignore'], ...(options?.env ? { env: { ...process.env, ...options.env } } : {}) }) as unknown as SayChild;

/** One speech process: text on stdin only, killed on abort or timeout (then `onStop` runs, best effort), never throws. `name` labels the failures (`Mac`, `System`). */
export function runSpeechChild({ file, args, env, text, signal, spawn = defaultSpawn, timeoutMs, name, onStop }: { file: string; args: string[]; env?: Record<string, string>; text: string; signal?: AbortSignal; spawn?: SaySpawn; timeoutMs: number; name: string; onStop?: () => void }): Promise<SayOutcome> {
  return new Promise<SayOutcome>(resolve => {
    if (signal?.aborted) { resolve({ ok: false, message: 'Speech cancelled.', cancelled: true }); return; }
    let child: SayChild;
    try { child = env ? spawn(file, args, { env }) : spawn(file, args); }
    catch { resolve({ ok: false, message: `${name} voice could not start.` }); return; }
    let settled = false;
    const finish = (outcome: SayOutcome, kill = false, stopped = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (kill) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
      if (stopped && onStop) { try { onStop(); } catch { /* the extra cancel is best effort */ } }
      resolve(outcome);
    };
    const abort = () => finish({ ok: false, message: 'Speech cancelled.', cancelled: true }, true, true);
    const timer = setTimeout(() => finish({ ok: false, message: `${name} voice timed out.` }, true, true), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish({ ok: false, message: `${name} voice failed.` }));
    child.on('exit', (code: number | null) => finish(code === 0 ? { ok: true, message: 'Speech completed.' } : { ok: false, message: `${name} voice failed.` }));
    try { child.stdin.on?.('error', () => finish({ ok: false, message: `${name} voice failed.` }, true)); child.stdin.write(text); child.stdin.end(); }
    catch { finish({ ok: false, message: `${name} voice failed.` }, true); }
  });
}

export function speakWithSay({ voice, text, speed, signal, spawn = defaultSpawn, timeoutMs }: { voice: string; text: string; speed: number; signal?: AbortSignal; spawn?: SaySpawn; timeoutMs?: number }): Promise<SayOutcome> {
  if (signal?.aborted) return Promise.resolve({ ok: false, message: 'Speech cancelled.', cancelled: true });
  if (!MAC_VOICE_NAME.test(voice)) return Promise.resolve({ ok: false, message: 'Invalid Mac voice name.' });
  return runSpeechChild({ file: SAY_PATH, args: ['-v', voice, '-r', String(Math.round(SAY_BASE_RATE * speed)), '-f', '-'], text, signal, spawn, timeoutMs: timeoutMs ?? sayTimeoutMs(text, speed), name: 'Mac' });
}
