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
import { execFile } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { CustomVoiceList } from './speak-custom-voices.ts';
import type { DotDetection } from './speak-dot.ts';
import { ffmpegHint, ffmpegPurpose } from './speak-setup.ts';
import { systemVoiceHint } from './speak-system-voice.ts';
import { defaultIsPidAlive } from './speak-voice-lock.ts';

/**
 * T44 (S15): `/speak doctor`. Every check is bounded (a probe that hangs or throws becomes a ✗) and read-only: nothing is written, installed, started or
 * downloaded. The probes are injected so the report is testable with fakes; the real ones are the `probe*` helpers below.
 */
export type CheckStatus = 'ok' | 'fail' | 'na';
export interface DoctorCheck { id: string; label: string; status: CheckStatus; detail: string; hint?: string }
export interface DoctorReport { checks: DoctorCheck[]; ok: number; failed: number; na: number }

export type ServiceProbe = { state: 'running'; pid?: number; version?: string; build?: string; /** Whether version and build equal what this code would start; undefined when unknown. */ current?: boolean } | { state: 'stale'; reason: string } | { state: 'absent' };
export type LockProbe = { state: 'free' } | { state: 'owned'; pid: number; alive: boolean };
export type FocusSource = 'terminal-events' | 'herdr' | 'unknown';
/** `lockCurrent: false` (T63): the env imports, but `python.json` does not record the current dependency lock (an earlier unlocked install or another lock). */
export interface PythonProbe { recorded: boolean; python?: string; exists?: boolean; importOk?: boolean; version?: string; message?: string; lockCurrent?: boolean }

export interface DoctorProbes {
  platform: string;
  /** `<platform>-<arch>`; the Qwen checks apply only on `darwin-arm64`. */
  target: string;
  runtime: () => Promise<{ state: 'missing' | 'installed' | 'invalid' }>;
  audio: () => Promise<{ ok: boolean; detail?: string }>;
  piper: () => Promise<Record<string, 'missing' | 'installed' | 'invalid'>>;
  python: () => Promise<PythonProbe>;
  base: () => Promise<'installed' | 'missing'>;
  design: () => Promise<'installed' | 'missing'>;
  customVoices: () => Promise<CustomVoiceList>;
  selectedVoice: () => Promise<{ ok: boolean; detail: string; hint?: string }>;
  service: () => Promise<ServiceProbe>;
  lock: () => Promise<LockProbe>;
  ffmpeg: () => string | undefined;
  systemVoice: () => Promise<{ available: boolean; detail: string }>;
  focus: () => Promise<FocusSource>;
  dot: () => DotDetection;
  /** Bound for each probe; default 8 s. */
  timeoutMs?: number;
}

const INSTALL_ALL = 'ejecutá /speak → «Instalar todo»';
const text = (error: unknown) => String((error as Error)?.message ?? error ?? 'error').replace(/\S*[\/\\]\S*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'error';

async function bounded<T>(work: () => Promise<T> | T, ms: number): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`sin respuesta tras ${Math.round(ms / 1000)} s`)), ms); })]);
    return { ok: true, value };
  } catch (error) { return { ok: false, message: text(error) }; }
  finally { clearTimeout(timer); }
}

/** Runs every check. Each is independent: one that fails or hangs never hides the others. Read-only. */
export async function runDoctor(probes: DoctorProbes): Promise<DoctorReport> {
  const ms = probes.timeoutMs ?? 8000;
  const qwen = probes.target === 'darwin-arm64';
  const check = async (id: string, label: string, work: () => Promise<Omit<DoctorCheck, 'id' | 'label'>> | Omit<DoctorCheck, 'id' | 'label'>): Promise<DoctorCheck> => {
    const out = await bounded(work, ms);
    return out.ok ? { id, label, ...out.value } : { id, label, status: 'fail', detail: `no pude comprobarlo (${out.message})`, hint: 'Volvé a ejecutar /speak doctor; si persiste, revisá el README (Troubleshooting).' };
  };
  const na = (detail: string) => ({ status: 'na' as const, detail });
  let runtimeInstalled = false;
  const checks: DoctorCheck[] = [];
  checks.push(await check('runtime', 'Runtime de audio', async () => {
    const state = (await probes.runtime()).state;
    runtimeInstalled = state === 'installed';
    return state === 'installed' ? { status: 'ok', detail: 'instalado y verificado' }
      : state === 'invalid' ? { status: 'fail', detail: 'instalación inválida', hint: 'Resolvela a mano: borrá ~/.gentle-speak/runtime y ejecutá /speak → «Instalar todo».' }
      : { status: 'fail', detail: 'no está instalado', hint: INSTALL_ALL };
  }));
  checks.push(await check('audio', 'Salida de audio', async () => {
    if (!runtimeInstalled) return { status: 'fail', detail: 'no se pudo probar: falta el runtime', hint: INSTALL_ALL };
    const out = await probes.audio();
    return out.ok ? { status: 'ok', detail: `el dispositivo de salida abre${out.detail ? ` (${out.detail})` : ''}; sin sonido` } : { status: 'fail', detail: `no abre el dispositivo de salida${out.detail ? `: ${out.detail}` : ''}`, hint: 'Revisá el dispositivo de salida del sistema (Bluetooth conectado, volumen) y volvé a probar.' };
  }));
  checks.push(await check('piper', 'Modelos Piper', async () => {
    const models = await probes.piper();
    const detail = Object.entries(models).map(([voice, state]) => `${voice} ${state === 'installed' ? 'instalado' : state === 'invalid' ? 'inválido' : 'no instalado'}`).join(', ');
    return models.es_MX === 'installed' ? { status: 'ok', detail } : { status: 'fail', detail, hint: INSTALL_ALL };
  }));
  checks.push(await check('python', 'Entorno Python + mlx-audio', async () => {
    if (!qwen) return na('solo en Apple Silicon (Qwen)');
    const python = await probes.python();
    if (!python.recorded) return { status: 'fail', detail: 'no hay entorno registrado', hint: `${INSTALL_ALL} (necesita uv o Python 3.12+: brew install python@3.12)` };
    if (python.exists === false) return { status: 'fail', detail: 'el intérprete registrado ya no existe', hint: INSTALL_ALL };
    const imports = `mlx_audio se importa${python.version ? ` (mlx-audio ${python.version})` : ''}`;
    if (python.importOk && python.lockCurrent === false) return { status: 'fail', detail: `${imports}, pero el entorno no se instaló con las dependencias fijadas actuales`, hint: INSTALL_ALL };
    return python.importOk ? { status: 'ok', detail: imports }
      : { status: 'fail', detail: `mlx_audio no se importa${python.message ? `: ${python.message}` : ''}`, hint: INSTALL_ALL };
  }));
  checks.push(await check('base', 'Modelo Qwen Base 0.6B (caché)', async () => {
    if (!qwen) return na('solo en Apple Silicon (Qwen)');
    return (await probes.base()) === 'installed' ? { status: 'ok', detail: 'en la caché de Hugging Face' } : { status: 'fail', detail: 'no está en la caché de Hugging Face', hint: INSTALL_ALL };
  }));
  checks.push(await check('design', 'Modelo VoiceDesign (opcional)', async () => {
    if (!qwen) return na('solo en Apple Silicon (Qwen)');
    return (await probes.design()) === 'installed' ? { status: 'ok', detail: 'en la caché de Hugging Face' } : { status: 'na', detail: 'no instalado (opcional: se descarga al usar /speak → «Crear voz propia…»)' };
  }));
  checks.push(await check('custom', 'Voces propias (sha256)', async () => {
    const list = await probes.customVoices();
    const valid = list.voices.length, invalid = list.skipped.length;
    if (!valid && !invalid) return na('ninguna todavía (opcional: /speak → «Crear voz propia…» o «Importar mi grabación…»)');
    return invalid ? { status: 'fail', detail: `${valid} ok, ${invalid} inválida${invalid === 1 ? '' : 's'} (${list.skipped.map(entry => entry.id).join(', ')})`, hint: 'Borrala con /speak → «Borrar voz propia…» y creala o importala de nuevo.' } : { status: 'ok', detail: `${valid} ok, 0 inválidas` };
  }));
  checks.push(await check('voice', 'Voz elegida', async () => {
    const out = await probes.selectedVoice();
    return out.ok ? { status: 'ok', detail: out.detail } : { status: 'fail', detail: out.detail, hint: out.hint ?? 'Elegí otra voz con /speak.' };
  }));
  checks.push(await check('service', 'Servicio Qwen compartido', async () => {
    if (!qwen) return na('solo en Apple Silicon (Qwen)');
    const out = await probes.service();
    if (out.state === 'running') return { status: 'ok', detail: `en ejecución${out.pid !== undefined ? `, pid ${out.pid}` : ''}${out.version ? `, versión ${out.version}` : ''}${out.build ? `, build ${out.build}` : ''}${out.current === false ? ' (distinto del código actual: el próximo uso lo reemplaza solo)' : ''}` };
    if (out.state === 'stale') return { status: 'fail', detail: `socket sin servicio (${out.reason})`, hint: 'El próximo uso de Qwen lo reinicia solo; también podés usar /speak → «Detener servicio Qwen».' };
    return { status: 'na', detail: 'no está corriendo: arranca al hablar con Qwen; si no puede, se usa un worker local por sesión' };
  }));
  checks.push(await check('lock', 'Cerrojo de voz', async () => {
    const out = await probes.lock();
    if (out.state === 'free') return { status: 'ok', detail: 'libre' };
    return out.alive ? { status: 'ok', detail: `en uso por el proceso vivo ${out.pid} (otra sesión está hablando)` } : { status: 'ok', detail: `lo tenía el proceso ${out.pid}, que ya no existe; se recupera solo al hablar` };
  }));
  checks.push(await check('ffmpeg', 'ffmpeg', async () => {
    const path = probes.ffmpeg();
    return path ? { status: 'ok', detail: 'encontrado' } : { status: 'fail', detail: `no está instalado (${ffmpegPurpose(qwen)})`, hint: ffmpegHint(probes.platform) };
  }));
  checks.push(await check('system', 'Voz del sistema', async () => {
    const out = await probes.systemVoice();
    return out.available ? { status: 'ok', detail: out.detail } : { status: 'fail', detail: out.detail, hint: systemVoiceHint(probes.platform) };
  }));
  checks.push(await check('focus', 'Fuente de foco', async () => {
    const out = await probes.focus();
    return out === 'terminal-events' ? { status: 'ok', detail: 'eventos de foco de la terminal' }
      : out === 'herdr' ? { status: 'ok', detail: 'Herdr' }
      : { status: 'na', detail: 'desconocido: las sesiones hablan por turnos con el nombre del proyecto' };
  }));
  checks.push(await check('dot', 'Conexión con Gentle Dot', async () => {
    const found = probes.dot();
    if (found.state === 'absent') return na('Gentle Dot no está instalado');
    if (found.state === 'malformed') return { status: 'fail', detail: 'su settings.json está mal formado', hint: 'Corregilo a mano; gentle-speak no lo toca.' };
    return found.connected ? { status: 'ok', detail: 'conectado' } : { status: 'na', detail: 'Gentle Dot está instalado pero no conectado (opcional: /speak → Gentle Dot → Conectar)' };
  }));
  return { checks, ok: checks.filter(c => c.status === 'ok').length, failed: checks.filter(c => c.status === 'fail').length, na: checks.filter(c => c.status === 'na').length };
}

const MARK: Record<CheckStatus, string> = { ok: '✓', fail: '✗', na: '–' };
/** Plain text, one line per check (and an indented fix hint under each ✗), then a summary line. No widget, no color: it also reads well as a tool result. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['gentle-speak doctor'];
  for (const check of report.checks) {
    lines.push(`${MARK[check.status]} ${check.label}: ${check.detail}`);
    if (check.hint && check.status !== 'ok') lines.push(`    → ${check.hint}`);
  }
  lines.push(report.failed ? `${report.failed} problema${report.failed === 1 ? '' : 's'} (✗), ${report.ok} ok (✓), ${report.na} no aplica o es opcional (–).` : `Todo en orden: ${report.ok} ok (✓), ${report.na} no aplica o es opcional (–).`);
  return lines.join('\n');
}

// ---- real probes (read-only) -----------------------------------------------------------------------------------------------------------

/** `voice.lock/owner.json` of the shared home: free, or the owner pid and whether it is alive. Never writes. */
export async function probeVoiceLock(home: string, isPidAlive: (pid: number) => boolean = defaultIsPidAlive): Promise<LockProbe> {
  try { lstatSync(join(home, 'voice.lock')); } catch { return { state: 'free' }; }
  try {
    const owner = JSON.parse(readFileSync(join(home, 'voice.lock', 'owner.json'), 'utf8'));
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) return { state: 'owned', pid: owner.pid, alive: isPidAlive(owner.pid) };
  } catch { /* being created or released */ }
  return { state: 'free' };
}

/**
 * The shared Qwen service, read-only and without connecting: any connection counts as a client of the service and would restart its grace countdown, so
 * the doctor looks at the socket file, the pid file (and whether that process lives) and the service's own `listening … (version V, build B, …)` log line.
 * `expected` (the version and build this code would start) only decides `current`. Never starts a service, never writes.
 */
export async function probeQwenService(home: string, { isPidAlive = defaultIsPidAlive, expected }: { isPidAlive?: (pid: number) => boolean; expected?: { version: string; build?: string } } = {}): Promise<ServiceProbe> {
  const socket = join(home, 'qwen.sock');
  try { if (!lstatSync(socket).isSocket()) return { state: 'stale', reason: 'qwen.sock no es un socket' }; } catch { return { state: 'absent' }; }
  let pid: number | undefined;
  try { const value = Number(readFileSync(join(home, 'qwen-service.pid'), 'utf8').trim()); if (Number.isSafeInteger(value) && value > 0) pid = value; } catch { /* no pid file */ }
  if (pid !== undefined && !isPidAlive(pid)) return { state: 'stale', reason: `el proceso ${pid} ya no existe` };
  let version: string | undefined, build: string | undefined;
  try {
    const log = readLogTail(join(home, 'qwen-service.log'));
    for (const line of log.split('\n').reverse()) {
      const match = /\[qwen-service (\d+)\] listening on .*\(version (\S+), build (\S+), grace/.exec(line);
      if (match && (pid === undefined || Number(match[1]) === pid)) { version = match[2].slice(0, 40); build = match[3] === 'unknown' ? undefined : match[3].slice(0, 20); break; }
    }
  } catch { /* no log: the pid alone */ }
  const current = expected && version !== undefined ? version === expected.version && (expected.build === undefined || build === expected.build) : undefined;
  return { state: 'running', pid, version, build, current };
}
function readLogTail(path: string): string {
  const size = statSync(path).size, max = 64 * 1024;
  const fd = openSync(path, 'r');
  try { const buffer = Buffer.alloc(Math.min(size, max)); readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length)); return buffer.toString('utf8'); } finally { closeSync(fd); }
}

/** The only variables the probe child needs: PATH to resolve, HOME and the temp dir for the platform audio stack. Nothing else of the caller's environment (tokens, API keys) reaches code loaded from the runtime. */
const probeEnv = (): NodeJS.ProcessEnv => Object.fromEntries((['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'XDG_RUNTIME_DIR'] as const).filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));

/**
 * Opens the default output device with a silent stream, in a child (`scripts/speak-audio-probe.cjs`) killed after `timeoutMs`. No sound. The child loads a
 * native addon from `runtimePath`, so it only runs for a runtime that checked out (`runtimeState: 'installed'`, when the caller knows it) at an absolute path,
 * and with a minimal environment.
 */
export function probeAudioDevice({ script, runtimePath, runtimeState, timeoutMs = 6000, exec = execFile }: { script: string; runtimePath: string; runtimeState?: 'missing' | 'installed' | 'invalid'; timeoutMs?: number; exec?: typeof execFile }): Promise<{ ok: boolean; detail?: string }> {
  if (runtimeState !== undefined && runtimeState !== 'installed') return Promise.resolve({ ok: false, detail: 'el runtime no está instalado y verificado' });
  if (typeof runtimePath !== 'string' || !isAbsolute(runtimePath) || runtimePath.includes('\0')) return Promise.resolve({ ok: false, detail: 'ruta de runtime inválida' });
  return new Promise(resolve => {
    exec(process.execPath, [script, runtimePath], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8', env: probeEnv(), windowsHide: true }, (error, stdout) => {
      let reply: any;
      try { reply = JSON.parse(String(stdout).trim().split('\n').pop() ?? ''); } catch { /* no reply */ }
      if (reply?.ok === true) resolve({ ok: true, detail: Number.isSafeInteger(reply.rate) ? `${reply.rate} Hz` : undefined });
      else resolve({ ok: false, detail: typeof reply?.message === 'string' ? reply.message.slice(0, 120) : error ? 'el sondeo no terminó a tiempo' : undefined });
    });
  });
}
