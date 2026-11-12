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
/**
 * System voice (S11, S16): the operating system's own speech, no download. macOS `say` (speak-say.ts), Linux `spd-say` or `espeak-ng`/`espeak`, Windows SAPI
 * through PowerShell. Same rules on every platform: the text goes on stdin only (never argv, never inside a script), the process is killed on abort or timeout.
 * Linux and Windows are written from the tools' documentation and tested with fakes only: unverified live.
 */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { MAC_VOICE_NAME, SAY_BASE_RATE, SAY_PATH, defaultSpawn, parseSayVoices, pickMacVoice, runSpeechChild, sayTimeoutMs, speakWithSay, type MacVoice, type SayOutcome, type SaySpawn } from './speak-say.ts';

export type SystemEngine = 'say' | 'spd-say' | 'espeak-ng' | 'espeak' | 'sapi';
export interface SystemEnv {
  platform?: string;
  /** macOS: whether `/usr/bin/say` exists. */
  exists?: (path: string) => boolean;
  /** Linux: the full path of a command on PATH, or undefined. */
  which?: (command: string) => string | undefined;
}
export interface SystemCommand { file: string; args: string[]; env?: Record<string, string> }

/** The voice used on Linux when nothing is listed: the engines' own Spanish. */
export const SYSTEM_DEFAULT_VOICE = 'es';
export const POWERSHELL = 'powershell.exe';
const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-Command'];
/** Fixed text: the utterance comes from stdin, the voice and rate from environment variables (never interpolated). No double quotes, so argv quoting cannot alter it. */
export const POWERSHELL_SPEAK_SCRIPT = "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Speech; [Console]::InputEncoding = [System.Text.Encoding]::UTF8; $text = [Console]::In.ReadToEnd(); $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; if ($env:GENTLE_SPEAK_VOICE) { $synth.SelectVoice($env:GENTLE_SPEAK_VOICE) }; $synth.Rate = [int]$env:GENTLE_SPEAK_RATE; $synth.Speak($text)";
/** One `Name|Culture` line per enabled installed voice. */
export const POWERSHELL_LIST_SCRIPT = "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Speech; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";

export const systemVoiceLabel = (platform: string = process.platform): string => platform === 'darwin' ? 'Mac' : 'Sistema';

const pathWhich = (command: string): string | undefined => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) { if (dir && existsSync(join(dir, command))) return join(dir, command); }
  return undefined;
};

export function detectSystemEngine({ platform = process.platform, exists = existsSync, which = pathWhich }: SystemEnv = {}): { engine: SystemEngine; file: string } | undefined {
  if (platform === 'darwin') return exists(SAY_PATH) ? { engine: 'say', file: SAY_PATH } : undefined;
  if (platform === 'win32') { const file = which(POWERSHELL); return file ? { engine: 'sapi', file } : undefined; } // T54: SAPI needs powershell.exe on PATH
  if (platform !== 'linux') return undefined;
  for (const engine of ['spd-say', 'espeak-ng', 'espeak'] as const) { const file = which(engine); if (file) return { engine, file }; }
  return undefined;
}
export const systemVoiceAvailable = (env: SystemEnv = {}): boolean => detectSystemEngine(env) !== undefined;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** say and espeak: words per minute (185 and 175 at speed 1); spd-say: -100..100; SAPI: -10..10. */
export function systemRate(engine: SystemEngine, speed: number): number {
  if (engine === 'say') return Math.round(SAY_BASE_RATE * speed);
  if (engine === 'espeak-ng' || engine === 'espeak') return Math.round(175 * speed);
  if (engine === 'spd-say') return clamp(Math.round((speed - 1) * 100), -100, 100);
  return clamp(Math.round((speed - 1) * 10), -10, 10);
}

/** The exact invocation. The text is never part of it. */
export function buildSystemCommand({ engine, file, voice, speed }: { engine: SystemEngine; file: string; voice: string; speed: number }): SystemCommand {
  const rate = systemRate(engine, speed);
  if (engine === 'say') return { file, args: ['-v', voice, '-r', String(rate), '-f', '-'] };
  if (engine === 'spd-say') return { file, args: ['-w', '-l', 'es', ...(voice && voice !== SYSTEM_DEFAULT_VOICE ? ['-y', voice] : []), '-r', String(rate), '-e'] };
  if (engine === 'sapi') return { file, args: [...POWERSHELL_FLAGS, POWERSHELL_SPEAK_SCRIPT], env: { GENTLE_SPEAK_VOICE: voice === SYSTEM_DEFAULT_VOICE ? '' : voice, GENTLE_SPEAK_RATE: String(rate) } };
  return { file, args: ['-v', voice || SYSTEM_DEFAULT_VOICE, '-s', String(rate), '--stdin'] };
}

/** How long the `spd-say -C` cancel child may run before it is killed (T55). */
export const SPD_CANCEL_TIMEOUT_MS = 2000;

export function speakWithSystemVoice({ voice, text, speed, signal, spawn, timeoutMs, cancelTimeoutMs = SPD_CANCEL_TIMEOUT_MS, ...env }: { voice: string; text: string; speed: number; signal?: AbortSignal; spawn?: SaySpawn; timeoutMs?: number; cancelTimeoutMs?: number } & SystemEnv): Promise<SayOutcome> {
  const platform = env.platform ?? process.platform;
  if (platform === 'darwin') return speakWithSay({ voice, text, speed, signal, spawn, timeoutMs });
  if (signal?.aborted) return Promise.resolve({ ok: false, message: 'Speech cancelled.', cancelled: true });
  const found = detectSystemEngine(env);
  if (!found) return Promise.resolve({ ok: false, message: 'System voice is not available.' });
  if (!MAC_VOICE_NAME.test(voice)) return Promise.resolve({ ok: false, message: 'Invalid system voice name.' });
  const command = buildSystemCommand({ engine: found.engine, file: found.file, voice, speed });
  // T54: killing spd-say leaves what speech-dispatcher already queued; `spd-say -C` (cancel) empties that queue. It is server-wide (a second process cannot cancel only our messages), so it runs only on stop or timeout.
  // T55: the cancel child is bounded too (SIGTERM at `cancelTimeoutMs`); it never delays or changes the stop outcome.
  const onStop = found.engine === 'spd-say' ? () => {
    const child = (spawn ?? defaultSpawn)(found.file, ['-C']);
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, cancelTimeoutMs);
    timer.unref?.();
    const done = () => clearTimeout(timer);
    child.on('error', done);
    child.on('exit', done);
    try { child.stdin.end(); } catch { /* nothing to close */ }
  } : undefined;
  return runSpeechChild({ file: command.file, args: command.args, env: command.env, text, signal, spawn, timeoutMs: timeoutMs ?? sayTimeoutMs(text, speed), name: 'System', onStop });
}

const isSpanish = (locale: string) => /^es(?:[-_]|$)/i.test(locale);
const norm = (locale: string) => locale.toLowerCase().replace('-', '_');

/** Only Spanish voices, whatever the engine prints. */
export function parseSystemVoices(engine: SystemEngine, output: string): MacVoice[] {
  if (engine === 'say') return parseSayVoices(output);
  const seen = new Set<string>();
  const voices: MacVoice[] = [];
  for (const line of output.split(/\r?\n/)) {
    let name: string | undefined; let locale: string | undefined;
    if (engine === 'sapi') { const m = /^(.+)\|([A-Za-z]{2,3}-[A-Za-z0-9]+)\s*$/.exec(line); [, name, locale] = m ?? []; }
    else if (engine === 'spd-say') { const m = /^\s*(.+?)\s{2,}([a-z]{2,3}(?:[-_][A-Za-z0-9]+)?)\s+\S+\s*$/.exec(line); [, name, locale] = m ?? []; }
    else { const m = /^\s*\d+\s+([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)\s+\S+\s+(\S+)/.exec(line); [, locale, name] = m ?? []; }
    if (!name || !locale || !isSpanish(locale)) continue;
    name = name.trim();
    if (!name || seen.has(`${name}\u0000${locale}`)) continue;
    seen.add(`${name}\u0000${locale}`);
    voices.push({ name, locale });
  }
  return voices;
}

/** How long a voice listing may run before its child is killed (T54): PowerShell loads System.Speech, so it is allowed longer. */
export const SYSTEM_LIST_TIMEOUT_MS = { sapi: 8000, default: 5000 } as const;
/** How long the extension waits for a listing: on Windows a little longer than the listing's own bound, so the kill happens first. */
export const systemVoiceProbeMs = (platform: string = process.platform): number => platform === 'win32' ? SYSTEM_LIST_TIMEOUT_MS.sapi + 1000 : 1500;

export interface ListChild {
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
  on(event: 'close' | 'error', listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export type ListSpawn = (file: string, args: string[]) => ListChild;
const defaultListSpawn: ListSpawn = (file, args) => spawnChild(file, args, { stdio: ['ignore', 'pipe', 'ignore'] }) as unknown as ListChild;

/** Runs a listing command: its stdout on exit 0, read after `close` so output still in the pipe is not lost (T55); rejects on failure, spawn error or timeout, and kills the child when the timeout fires. */
const runList = (timeout: number, spawn: ListSpawn) => (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
  let child: ListChild;
  try { child = spawn(file, args); } catch (error) { reject(error); return; }
  let out = '';
  let settled = false;
  const finish = (error?: unknown, kill = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (kill) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    if (error) reject(error); else resolve(out);
  };
  const timer = setTimeout(() => finish(new Error('voice listing timed out'), true), timeout);
  child.stdout?.on('data', chunk => { if (out.length < (1 << 20)) out += String(chunk); });
  child.on('error', error => finish(error ?? new Error('voice listing failed')));
  child.on('close', (code: number | null) => finish(code === 0 ? undefined : new Error(`voice listing exited with ${code}`)));
});

/** Installed Spanish voices of the platform's engine; empty when it cannot be run or does not answer within its bound. */
export async function listSystemVoices({ run, spawn, timeoutMs, ...env }: { run?: (file: string, args: string[]) => Promise<string>; spawn?: ListSpawn; timeoutMs?: number } & SystemEnv = {}): Promise<MacVoice[]> {
  const found = detectSystemEngine(env);
  if (!found) return [];
  const args = found.engine === 'say' ? ['-v', '?'] : found.engine === 'sapi' ? [...POWERSHELL_FLAGS, POWERSHELL_LIST_SCRIPT]
    : found.engine === 'spd-say' ? ['-l', 'es', '-O'] : ['--voices=es'];
  const bound = timeoutMs ?? (found.engine === 'sapi' ? SYSTEM_LIST_TIMEOUT_MS.sapi : SYSTEM_LIST_TIMEOUT_MS.default);
  try { return parseSystemVoices(found.engine, await (run ?? runList(bound, spawn ?? defaultListSpawn))(found.file, args)); } catch { return []; }
}

/** `preferred` when installed, else the platform's Spanish order: macOS Paulina/Mónica; Windows Sabina (es-MX), Helena (es-ES); Linux Latin-American Spanish, plain `es`; then the first Spanish voice. */
export function pickSystemVoice(voices: readonly MacVoice[], preferred: string | null | undefined, platform: string = process.platform): string | undefined {
  if (platform === 'darwin') return pickMacVoice(voices, preferred);
  if (preferred && voices.some(voice => voice.name === preferred)) return preferred;
  const spanish = voices.filter(voice => isSpanish(voice.locale));
  const byName = (re: RegExp) => spanish.find(voice => re.test(voice.name));
  const latam = spanish.find(voice => ['es_419', 'es_mx'].includes(norm(voice.locale)));
  if (platform === 'win32') return (byName(/Sabina/i) ?? byName(/Helena/i) ?? latam ?? spanish[0])?.name;
  return (latam ?? spanish.find(voice => norm(voice.locale) === 'es') ?? spanish[0])?.name;
}
/** Like `pickSystemVoice`, but Linux with nothing listed still speaks with the engine's own Spanish (`es`). */
export function resolveSystemVoice(voices: readonly MacVoice[], preferred: string | null | undefined, platform: string = process.platform): string | undefined {
  return pickSystemVoice(voices, preferred, platform) ?? (platform === 'linux' ? SYSTEM_DEFAULT_VOICE : undefined);
}

const ENGINE_NAME: Record<SystemEngine, string> = { say: 'say', 'spd-say': 'spd-say', 'espeak-ng': 'espeak-ng', espeak: 'espeak', sapi: 'SAPI' };
/** The doctor's «Voz del sistema» line: the platform engine and its voices, or the missing tool. Setup never installs these packages. */
export function systemVoiceStatus(env: SystemEnv, voices: readonly MacVoice[], preferred: string | null | undefined): { available: boolean; detail: string } {
  const platform = env.platform ?? process.platform;
  const found = detectSystemEngine(env);
  if (!found) return { available: false, detail: platform === 'darwin' ? '`say` no está disponible' : platform === 'linux' ? 'falta `spd-say` (speech-dispatcher) o `espeak-ng`' : platform === 'win32' ? 'falta `powershell.exe` en el PATH' : 'no hay voz del sistema para esta plataforma' };
  const name = ENGINE_NAME[found.engine];
  const chosen = pickSystemVoice(voices, preferred, platform);
  if (chosen) return { available: true, detail: `${name}: ${voices.length} voz/voces en español (elegida: ${chosen})` };
  if (platform === 'linux') return { available: true, detail: `${name}: sin voces listadas; usa «${SYSTEM_DEFAULT_VOICE}»` };
  return { available: false, detail: `${name}: no hay voces en español instaladas` };
}
export function systemVoiceHint(platform: string = process.platform): string {
  if (platform === 'darwin') return 'Instalá una voz en español en Ajustes del Sistema → Accesibilidad → Contenido hablado.';
  if (platform === 'win32') return 'La voz SAPI viene integrada en Windows; instalá un idioma español en Configuración → Hora e idioma → Voz.';
  return 'sudo apt install speech-dispatcher espeak-ng (o el gestor de paquetes de tu distribución)';
}
