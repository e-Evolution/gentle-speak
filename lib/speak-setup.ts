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
import { SPEAK_MODELS, speakRuntimeManifest, type SpeakModelManifest, type SpeakRuntimeManifest, type SpeakTarget } from './speak-install.ts';
import { PYTHON_ENV_APPROX_BYTES, PYTHON_ENV_SIZE_SOURCE, PYTHON_INSTRUCTION, type PythonEnvOutcome, type PythonTooling, type Which } from './speak-python-env.ts';

/**
 * What gentle-speak needs to be ready after install, what is missing and how big it is, and the sequential install of the missing parts.
 * Pi installs packages with `--ignore-scripts`, so this runs on the first terminal start (one confirmation) or from `/speak` → «Instalar todo».
 * The VoiceDesign model is never part of it (it has its own explicit download). Nothing here installs a system package: ffmpeg is only detected and hinted.
 */
export type ComponentId = 'runtime' | 'piper' | 'python' | 'qwen-base';
export type ComponentState = 'installed' | 'missing' | 'invalid';
export interface SetupComponent {
  id: ComponentId;
  label: string;
  state: ComponentState;
  /** Estimated download or disk size in bytes. */
  bytes: number;
  /** Where `bytes` comes from (always shown with it). */
  sizeSource: string;
  /** Set when the component cannot be installed right now (no Python tooling): why, and what the user can do. */
  blocked?: string;
}
export interface FfmpegStatus { present: boolean; path?: string; hint: string }
export interface SetupPlan {
  components: SetupComponent[];
  /** Components that are not installed, whether or not they can be installed now. */
  missing: SetupComponent[];
  /** Missing and installable now (what the confirmation lists and the install runs). */
  actionable: SetupComponent[];
  /** Sum of `actionable` sizes. */
  totalBytes: number;
  ffmpeg: FfmpegStatus;
  qwenSupported: boolean;
}

export const QWEN_TARGET = 'darwin-arm64';
/**
 * Measured 2026-11-12 on the local Hugging Face cache snapshot of the Base repo (`du -skL`: 2 457 208 KiB). It is the size the confirmation shows; the plan
 * never asks the Hugging Face API, so nothing reaches the network before the user confirms.
 */
export const QWEN_BASE_APPROX_BYTES = 2_457_208 * 1024;
export const QWEN_BASE_SIZE_SOURCE_APPROX = 'aprox., medido en la caché local de Hugging Face el 2026-11-12';

/** `brew install ffmpeg` on macOS; the platform's own package command elsewhere. Never run by gentle-speak. */
export function ffmpegHint(platform: string): string {
  return platform === 'darwin' ? 'brew install ffmpeg' : platform === 'win32' ? 'winget install ffmpeg' : 'sudo apt install ffmpeg (o el gestor de paquetes de tu distribución)';
}
export function ffmpegStatus(which: Which, platform: string): FfmpegStatus {
  const path = which(platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') ?? which('ffmpeg');
  return { present: path !== undefined, path, hint: ffmpegHint(platform) };
}

/** Why ffmpeg is mentioned: it only matters for changing the speed of Qwen voices, which exist on Apple Silicon only. */
export const ffmpegPurpose = (qwen: boolean): string => qwen ? 'opcional: solo hace falta para cambiar la velocidad de las voces Qwen' : 'opcional';

export interface SetupEnv {
  home: string;
  /** `<platform>-<arch>`, e.g. `darwin-arm64`; the Qwen components exist only on `darwin-arm64`. */
  target: string;
  platform: string;
  runtimeStatus: (options: { home: string; target: SpeakTarget; manifest?: SpeakRuntimeManifest }) => Promise<{ state: ComponentState }>;
  modelStatus: (options: { home: string; voice: 'es_MX' | 'es_ES'; manifest?: SpeakModelManifest }) => Promise<{ state: ComponentState }>;
  /** `outdated` marks an env whose interpreter works but was not installed from the current dependency lock (setup installs the lock into it). */
  pythonStatus: (home: string) => Promise<{ state: 'installed' | 'missing'; outdated?: boolean }>;
  tooling: () => Promise<PythonTooling>;
  baseStatus: (hfHome: string) => Promise<'installed' | 'missing'>;
  hfHome: string;
  which: Which;
}

const safeState = async (read: () => Promise<{ state: ComponentState }>): Promise<ComponentState> => { try { return (await read()).state; } catch { return 'invalid'; } };

/** The components that are missing, with their sizes. Read-only: nothing is created, downloaded or run (Python is only probed for its version), and no network request is made. */
export async function computeSetupPlan(env: SetupEnv): Promise<SetupPlan> {
  const runtimeTarget = env.target as SpeakTarget;
  let runtimeBytes = 0;
  try { runtimeBytes = speakRuntimeManifest(runtimeTarget).packages.reduce((sum, pkg) => sum + pkg.size, 0); } catch { /* unsupported platform: the runtime cannot be installed */ }
  const components: SetupComponent[] = [];
  const runtimeSupported = runtimeBytes > 0;
  if (runtimeSupported) components.push({ id: 'runtime', label: 'Runtime de audio nativo (sherpa-onnx + node-cpal)', state: await safeState(() => env.runtimeStatus({ home: env.home, target: runtimeTarget })), bytes: runtimeBytes, sizeSource: 'tamaño fijado de los paquetes npm' });
  const piper = SPEAK_MODELS.es_MX.files.reduce((sum, file) => sum + file.size, 0);
  components.push({ id: 'piper', label: 'Voz Piper es_MX', state: await safeState(() => env.modelStatus({ home: env.home, voice: 'es_MX' })), bytes: piper, sizeSource: 'tamaño fijado del archivo' });
  const qwenSupported = env.target === QWEN_TARGET;
  if (qwenSupported) {
    const tooling = await env.tooling().catch((): PythonTooling => ({ kind: 'none', instruction: PYTHON_INSTRUCTION }));
    const pythonStatus = await env.pythonStatus(env.home).catch((): { state: 'missing'; outdated?: boolean } => ({ state: 'missing' }));
    const pythonState = pythonStatus.state, pythonRuns = pythonState === 'installed' || pythonStatus.outdated === true;
    const blocked = tooling.kind === 'none' ? tooling.instruction : undefined;
    components.push({ id: 'python', label: 'Entorno Python de gentle-speak con mlx-audio', state: pythonState, bytes: PYTHON_ENV_APPROX_BYTES, sizeSource: PYTHON_ENV_SIZE_SOURCE, ...(pythonState === 'missing' && blocked ? { blocked } : {}) });
    const baseState = await env.baseStatus(env.hfHome).catch(() => 'missing' as const);
    components.push({ id: 'qwen-base', label: 'Modelo Qwen3-TTS Base 0.6B', state: baseState, bytes: QWEN_BASE_APPROX_BYTES, sizeSource: QWEN_BASE_SIZE_SOURCE_APPROX, ...(baseState === 'missing' && blocked && !pythonRuns ? { blocked } : {}) }); // an existing env (even an outdated one) needs no tooling to download the model
  }
  const missing = components.filter(component => component.state !== 'installed');
  const actionable = missing.filter(component => component.state === 'missing' && !component.blocked);
  return { components, missing, actionable, totalBytes: actionable.reduce((sum, component) => sum + component.bytes, 0), ffmpeg: ffmpegStatus(env.which, env.platform), qwenSupported };
}

export const formatBytes = (bytes: number): string => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** The one confirmation: every actionable component with its size and source, the total, what is blocked and the ffmpeg hint. Plain text. */
export function describeSetupPlan(plan: SetupPlan): string {
  const lines = ['gentle-speak necesita instalar:'];
  for (const component of plan.actionable) lines.push(`• ${component.label}: ${formatBytes(component.bytes)} (${component.sizeSource})`);
  lines.push(`Total: ${formatBytes(plan.totalBytes)}. Se instala en segundo plano, uno por uno.`);
  for (const component of plan.missing) if (component.blocked) lines.push(`• ${component.label}: no se puede instalar todavía. ${component.blocked}`);
  for (const component of plan.missing) if (component.state === 'invalid') lines.push(`• ${component.label}: instalación inválida; resolvela a mano, no la reemplazo.`);
  if (!plan.ffmpeg.present) lines.push(`ffmpeg no está instalado (${ffmpegPurpose(plan.qwenSupported)}). Si lo querés: ${plan.ffmpeg.hint}`);
  return lines.join('\n');
}

export type SetupProgress = { component: ComponentId; phase: 'start' | 'progress' | 'done' | 'failed' | 'skipped'; message?: string; received?: number; total?: number };
export interface SetupResult { id: ComponentId; label: string; status: 'installed' | 'failed' | 'skipped'; message?: string }
export interface SetupInstallers {
  installRuntime: (options: { home: string; target: SpeakTarget; confirmed: true; signal?: AbortSignal; onProgress?: (received: number, total: number) => void }) => Promise<unknown>;
  installPiper: (options: { home: string; voice: 'es_MX'; confirmed: true; signal?: AbortSignal; onProgress?: (received: number, total: number) => void }) => Promise<unknown>;
  ensurePython: (options: { home: string; confirmed: true; signal?: AbortSignal; onProgress?: (message: string) => void }) => Promise<PythonEnvOutcome>;
  installBase: (options: { python: string; hfHome: string; home: string; confirmed: true; signal?: AbortSignal }) => Promise<void>;
  resolvePython: (home: string) => string | undefined;
}
const reason = (error: unknown) => String((error as Error)?.message ?? error ?? 'error').replace(/\S*[\/\\]\S*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'error';

/**
 * Installs `components` in order (runtime, Piper, Python env, Base model), one at a time. One failure stops only that component: the others still run,
 * and the Base model, which needs the environment, is skipped when the environment did not install. The caller must have the human's confirmation.
 */
export async function runSetup({ plan, env, installers, signal, onProgress }: { plan: SetupPlan; env: Pick<SetupEnv, 'home' | 'target' | 'hfHome'>; installers: SetupInstallers; signal?: AbortSignal; onProgress?: (progress: SetupProgress) => void }): Promise<SetupResult[]> {
  const results: SetupResult[] = [];
  const todo = new Set(plan.actionable.map(component => component.id));
  const labelOf = (id: ComponentId) => plan.components.find(component => component.id === id)!.label;
  const record = (id: ComponentId, status: SetupResult['status'], message?: string) => { results.push({ id, label: labelOf(id), status, message }); onProgress?.({ component: id, phase: status === 'installed' ? 'done' : status, message }); };
  let python: string | undefined = env.target === QWEN_TARGET ? installers.resolvePython(env.home) : undefined;
  const step = async (id: ComponentId, work: () => Promise<void>) => {
    if (!todo.has(id)) return;
    if (signal?.aborted) { record(id, 'skipped', 'cancelado'); return; }
    onProgress?.({ component: id, phase: 'start' });
    try { await work(); } catch (error) { record(id, 'failed', signal?.aborted ? 'cancelado' : reason(error)); }
  };
  const transfer = (id: ComponentId) => (received: number, total: number) => onProgress?.({ component: id, phase: 'progress', received, total });
  await step('runtime', async () => { await installers.installRuntime({ home: env.home, target: env.target as SpeakTarget, confirmed: true, signal, onProgress: transfer('runtime') }); record('runtime', 'installed'); });
  await step('piper', async () => { await installers.installPiper({ home: env.home, voice: 'es_MX', confirmed: true, signal, onProgress: transfer('piper') }); record('piper', 'installed'); });
  await step('python', async () => {
    const outcome = await installers.ensurePython({ home: env.home, confirmed: true, signal, onProgress: message => onProgress?.({ component: 'python', phase: 'progress', message }) });
    if (outcome.status === 'installed') { python = outcome.python; record('python', 'installed'); }
    else if (outcome.status === 'skipped') record('python', 'skipped', outcome.instruction);
    else record('python', 'failed', outcome.message);
  });
  if (todo.has('qwen-base')) {
    if (!python && !signal?.aborted) record('qwen-base', 'skipped', 'necesita el entorno Python de gentle-speak, que no quedó instalado');
    else await step('qwen-base', async () => { await installers.installBase({ python: python!, hfHome: env.hfHome, home: env.home, confirmed: true, signal }); record('qwen-base', 'installed'); });
  }
  return results;
}

/** «gentle-speak listo» when everything installed, else one line per component that did not. Plain text. */
export function summarizeSetup(results: readonly SetupResult[], ffmpeg: FfmpegStatus, qwen = true): string {
  const bad = results.filter(result => result.status !== 'installed');
  const lines = bad.length ? ['gentle-speak: instalación incompleta.', ...results.map(result => `${result.status === 'installed' ? '✓' : result.status === 'skipped' ? '–' : '✗'} ${result.label}${result.message ? `: ${result.message}` : ''}`)] : ['gentle-speak listo'];
  if (!ffmpeg.present) lines.push(`ffmpeg: no está instalado (${ffmpegPurpose(qwen)}); si lo querés, ejecutá ${ffmpeg.hint}`);
  return lines.join('\n');
}

export const QWEN_CREATE_VOICE_SUGGESTION = 'Qwen está listo y todavía no tenés una voz propia: probá /speak → «Crear voz propia…».';
